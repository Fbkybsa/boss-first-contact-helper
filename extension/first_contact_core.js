/* Pure first-contact rules and one-shot send sequence. Also loaded by node:test. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BTFirstContact = api;
})(globalThis, function () {
  "use strict";

  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const nodeText = (node) => clean(node?.textContent || node?.getAttribute?.("title"));
  const firstText = (scope, selectors) => {
    for (const selector of selectors) {
      const value = nodeText(scope?.querySelector?.(selector));
      if (value) return value;
    }
    return "";
  };

  function extractIdentity(root, selectedRow) {
    return {
      company: firstText(root, [
        ".top-info-content .base-info > span:not(.base-title)",
        ".top-info-content .company-name",
        ".top-info-content [class*=company-name]",
        ".top-info-content [class*=companyName]",
      ]) || firstText(selectedRow, [
        ".name-box > span:nth-of-type(2)", ".company-name", "[class*=company-name]",
      ]),
      hr: firstText(root, [
        ".top-info-content .name-text",
        ".top-info-content [class*=name-text]",
        ".top-info-content [class*=boss-name]",
        ".top-info-content [class*=recruiter-name]",
      ]) || firstText(selectedRow, [
        ".name-box .name-text", ".name-text", "[class*=name-text]",
      ]),
      job: firstText(root, [
        ".chat-position-content .position-name",
        ".chat-position-content [class*=position-name]",
        ".chat-position-content [class*=job-name]",
        ".chat-position-content [class*=job-title]",
        ".chat-position-content .left-content > :first-child",
        "[ka=geek_chat_job_detail] .left-content > :first-child",
      ]),
    };
  }

  const identityParts = (snapshot) => {
    const identity = snapshot?.identity || {};
    return [identity.company, identity.hr, identity.job].map(clean);
  };

  function controlsReady(snapshot, action = "both") {
    if (action === "image") {
      return snapshot?.imageControlsReady ?? snapshot?.controlsReady;
    }
    if (action === "text") {
      return snapshot?.textControlsReady ?? snapshot?.controlsReady;
    }
    return snapshot?.controlsReady;
  }

  function targetReady(snapshot, action = "both") {
    if (!snapshot || snapshot.security) return "页面未就绪或出现安全验证";
    const missing = identityParts(snapshot)
      .map((value, index) => value ? "" : ["公司", "HR", "岗位"][index])
      .filter(Boolean);
    if (missing.length) return `无法确认当前会话的${missing.join("、")}；请等待会话信息加载后重试`;
    if (!controlsReady(snapshot, action)) {
      if (action === "image") return "图片发送控件未就绪";
      if (action === "text") return "消息输入框或文字发送按钮未就绪";
      return "消息输入框或图片发送控件未就绪";
    }
    return "";
  }

  function identityHash(value) {
    let hash = 2166136261;
    for (const char of value) {
      hash ^= char.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function assess(snapshot) {
    const notReady = targetReady(snapshot);
    if (notReady) return { ok: false, reason: notReady };
    const messages = snapshot.messages;
    if (!Array.isArray(messages) || !messages.length) {
      return { ok: false, reason: "消息记录尚未加载，无法判断是否首次接触" };
    }
    if (messages.some((item) => item.direction === "unknown" || item.kind === "unknown")) {
      return { ok: false, reason: "消息记录包含无法识别的内容" };
    }
    if (messages.some((item) => item.direction === "system" &&
        /图片|简历|附件/.test(clean(item.text)))) {
      return { ok: false, reason: "会话已有图片或简历相关系统记录" };
    }
    const sent = messages.filter((item) => item.direction === "self");
    if (sent.length !== 1 || sent[0].kind !== "text" || !clean(sent[0].text)) {
      return { ok: false, reason: "会话不是只有一条打招呼文字，无法按首次接触发送" };
    }
    if (!clean(sent[0].id)) return { ok: false, reason: "首条消息缺少平台 ID，无法防止重复发送" };
    return {
      ok: true,
      anchor: ["auto", ...identityParts(snapshot), clean(sent[0].id)].join("\u001f"),
      attemptKey: `bt-first-contact:${clean(sent[0].id)}`,
    };
  }

  function assessManual(snapshot, action = "both") {
    if (!snapshot || snapshot.security) {
      return { ok: false, reason: "页面未就绪或出现安全验证" };
    }
    if (!controlsReady(snapshot, action)) {
      const reason = action === "image" ? "图片发送控件未就绪" :
        action === "text" ? "消息输入框或文字发送按钮未就绪" :
          "消息输入框或图片发送控件未就绪";
      return { ok: false, reason };
    }
    const firstSelfId = (snapshot.messages || []).find((item) => item.direction === "self" && clean(item.id))?.id;
    const firstMessageId = (snapshot.messages || []).find((item) => clean(item.id))?.id;
    const anchorType = clean(firstMessageId) ? "message" :
      clean(snapshot.selectedConversationKey) ? "selected" :
        clean(snapshot.conversationId) ? "conversation" : "";
    const anchorValue = anchorType === "message" ? clean(firstMessageId) :
      anchorType === "selected" ? clean(snapshot.selectedConversationKey) :
        anchorType === "conversation" ? clean(snapshot.conversationId) : "";
    if (!anchorType) {
      return { ok: false, reason: "当前会话标识尚未加载；请稍后重试" };
    }
    const anchor = `manual\u001f${JSON.stringify({ type: anchorType, value: anchorValue })}`;
    return {
      ok: true,
      anchor,
      attemptKey: firstSelfId
        ? `bt-first-contact:${clean(firstSelfId)}`
        : `bt-first-contact:manual-${identityHash(anchor)}`,
    };
  }

  function sameAnchor(snapshot, anchor) {
    if (!snapshot || snapshot.security) return false;
    const [mode] = String(anchor || "").split("\u001f");
    if (mode === "manual") {
      let expected;
      try {
        expected = JSON.parse(String(anchor).slice("manual\u001f".length));
      } catch (_error) {
        return false;
      }
      const current = {
        message: clean((snapshot.messages || []).find((item) => clean(item.id))?.id),
        conversation: clean(snapshot.conversationId),
        selected: clean(snapshot.selectedConversationKey),
      };
      return !!expected.type && !!expected.value && current[expected.type] === expected.value;
    }
    const identity = identityParts(snapshot);
    const first = (snapshot.messages || []).find((item) => item.direction === "self");
    return ["auto", ...identity, clean(first?.id)].join("\u001f") === anchor;
  }

  function newChatCandidates(previous, current) {
    const seen = new Map((previous || []).map((row) => [row.key, row]));
    return (current || []).filter((row) => {
      if (!row.key || !row.message || !row.atTop) return false;
      return !seen.has(row.key);
    }).map((row) => row.key);
  }

  function confirmOpenedConversation(selectedRow, snapshot) {
    if (!selectedRow) return { ok: false, reason: "新会话列表项尚未选中" };
    if (!snapshot || snapshot.security) return { ok: false, reason: "会话页面未就绪或出现安全验证" };
    const [company, hr, job] = identityParts(snapshot);
    if (company !== clean(selectedRow.company) || hr !== clean(selectedRow.hr)) {
      return { ok: false, reason: "会话抬头与选中的公司或 HR 不一致" };
    }
    if (!job || !snapshot.controlsReady) {
      return { ok: false, reason: "岗位或消息发送控件尚未加载" };
    }
    if (!Array.isArray(snapshot.messages) || !snapshot.messages.some((item) => clean(item.id))) {
      return { ok: false, reason: "会话消息尚未加载" };
    }
    return { ok: true };
  }

  function retryableEligibility(reason) {
    return /页面未就绪|无法确认当前会话|当前会话标识尚未加载|控件未就绪|消息记录尚未加载|消息记录包含无法识别|首条消息缺少平台 ID/
      .test(String(reason || ""));
  }

  async function run(adapter, options = {}) {
    const mode = options.mode === "manual" ? "manual" : "auto";
    const requestedAction = ["image", "text"].includes(options.action) ? options.action : "both";
    const action = mode === "auto" ? "both" : requestedAction;
    const needsImage = action === "both" || action === "image";
    const needsText = action === "both" || action === "text";
    let stage = "检查";
    try {
      let initial = await adapter.read();
      let eligibility = mode === "manual" ? assessManual(initial, action) : assess(initial);
      for (let waited = 0;
        waited < 3000 && !initial?.security && !eligibility.ok &&
          retryableEligibility(eligibility.reason);
        waited += 250) {
        await adapter.delay(250);
        initial = await adapter.read();
        eligibility = mode === "manual" ? assessManual(initial, action) : assess(initial);
      }
      if (!eligibility.ok) return { ok: false, stage, reason: eligibility.reason };

      const settings = await adapter.settings();
      if (needsImage) {
        if (!settings?.resume?.exists) throw new Error("请先在本地管理页配置简历图片");
        if (settings.resume.mime && !["image/jpeg", "image/png"].includes(settings.resume.mime)) {
          throw new Error("平台图片控件只接受 JPG/PNG，请重新配置简历图片");
        }
      }
      const message = String(settings.advantage_message || "").trim();
      if (needsText && !message) throw new Error("请先在本地管理页配置图片后的话术");
      const image = needsImage ? await adapter.image() : null;
      if (needsImage && !image) throw new Error("无法读取简历图片");

      const assertTarget = async (expectFirst = false) => {
        const current = await adapter.read();
        if (!sameAnchor(current, eligibility.anchor)) {
          throw new Error("当前会话已切换或进入验证页，发送已停止");
        }
        if (mode === "auto" && expectFirst && !assess(current).ok) {
          throw new Error("会话已出现其他已发内容，无法继续按首次接触发送");
        }
        return current;
      };
      await assertTarget(true);
      if (mode === "auto" && !(await adapter.claim(eligibility.attemptKey))) {
        throw new Error("这个会话已有一次发送尝试；请检查消息流并手动处理剩余步骤");
      }

      let sentBeforeImage = 0;
      if (needsImage) {
        stage = "图片";
        await adapter.stage(eligibility.attemptKey, "image_started");
        const beforeImage = await assertTarget(true);
        sentBeforeImage = beforeImage.messages.filter((item) => item.direction === "self").length;
        await adapter.sendImage(image, eligibility.anchor, mode);
        if (!(await adapter.confirmImage(eligibility.anchor))) {
          throw new Error(action === "image" ? "无法确认图片已发送，请检查消息流" :
            "无法确认图片已发送；已停止话术发送，请检查消息流");
        }
        await adapter.stage(eligibility.attemptKey, "image_sent", { willSendText: needsText });
        if (!needsText) {
          await adapter.stage(eligibility.attemptKey, "image_only_complete");
          return { ok: true, stage: "完成", reason: "简历图片已发送" };
        }
      }

      stage = "话术";
      await assertTarget();
      if (needsImage) {
        await adapter.delay(500);
        const afterImage = await assertTarget();
        const sent = afterImage.messages.filter((item) => item.direction === "self");
        if (mode === "auto") {
          if (afterImage.messages.some((item) => item.direction === "unknown" || item.kind === "unknown") ||
              sent.length !== 2 || sent[0].kind !== "text" || sent[1].kind !== "image") {
            throw new Error("等待后会话不再是招呼加一张图片；图片已发送，话术未发，请核对消息流");
          }
        } else if (sent.length !== sentBeforeImage + 1 || sent.at(-1)?.kind !== "image") {
          throw new Error("等待后已发消息不止新增一张图片；图片已发送，话术未发，请核对消息流");
        }
      }
      await adapter.sendText(message, eligibility.anchor);
      if (!(await adapter.confirmText(eligibility.anchor, message))) {
        throw new Error(needsImage ? "图片已发送，但无法确认话术已发送；请检查消息流" :
          "无法确认话术已发送；请检查消息流");
      }
      await adapter.stage(eligibility.attemptKey, action === "text" ? "text_only_complete" : "complete");
      return { ok: true, stage: "完成", reason: action === "text" ? "个人优势文字已发送" :
        "图片和话术均已发送" };
    } catch (error) {
      return { ok: false, stage, reason: String(error?.message || error) };
    }
  }

  return { extractIdentity, assess, assessManual, sameAnchor, newChatCandidates,
    confirmOpenedConversation, run };
});
