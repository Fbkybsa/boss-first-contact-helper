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

  function textSequence(settings) {
    const raw = settings?.advantage_messages ?? [String(settings?.advantage_message || "").trim()].filter(Boolean);
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3 ||
        raw.some(text => typeof text !== "string" || !text.trim() || text.trim().length > 300)) {
      throw new Error("请在本地管理页配置 1 到 3 段话术，每段不能为空且最多 300 字符");
    }
    return raw.map(text => text.trim());
  }

  const ownMessages = snapshot => (snapshot.messages || []).filter(item => item.direction === "self");
  const sameSent = (before, after) => before.length === after.length &&
    before.every((item, index) => item.kind === after[index].kind && clean(item.text) === clean(after[index].text));

  const IMAGE_INTERVAL_MS = 500;

  function configuredImages(settings) {
    const list = Array.isArray(settings?.resumes)
      ? settings.resumes.filter((item) => item && typeof item === "object")
      : [];
    if (list.length) return list;
    return settings?.resume?.exists ? [settings.resume] : [];
  }

  async function loadImages(adapter, entries) {
    if (entries.length === 1 && typeof adapter.images !== "function") {
      return [await adapter.image()];
    }
    if (typeof adapter.images !== "function") {
      throw new Error("当前扩展版本不支持多张图片，请重新加载扩展");
    }
    const images = await adapter.images();
    if (!Array.isArray(images) || images.length !== entries.length) {
      throw new Error("读取到的图片数量与设置不一致，请重新配置图片");
    }
    return images;
  }

  async function run(adapter, options = {}) {
    const mode = options.mode === "manual" ? "manual" : "auto";
    const requestedAction = ["image", "text"].includes(options.action) ? options.action : "both";
    const action = mode === "auto" ? "both" : requestedAction;
    const needsImage = action === "both" || action === "image";
    const needsText = action === "both" || action === "text";
    let stage = "检查";
    let textSent = 0;
    let textTotal = 0;
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
      const imageEntries = needsImage ? configuredImages(settings) : [];
      if (needsImage) {
        if (!imageEntries.length) throw new Error("请先在本地管理页配置简历图片");
        if (imageEntries.some((item) => item.exists === false)) {
          throw new Error("有简历图片文件缺失，请重新配置图片");
        }
        if (imageEntries.some((item) => item.mime &&
            !["image/jpeg", "image/png"].includes(item.mime))) {
          throw new Error("平台图片控件只接受 JPG/PNG，请重新配置简历图片");
        }
      }
      const messages = needsText ? textSequence(settings) : [];
      textTotal = messages.length;
      const images = needsImage ? await loadImages(adapter, imageEntries) : [];
      if (needsImage && images.some((image) => !image)) throw new Error("无法读取简历图片");

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

      let sentBeforeImages = 0;
      if (needsImage) {
        sentBeforeImages = ownMessages(await assertTarget(true)).length;
        for (let index = 0; index < images.length; index += 1) {
          const isLast = index === images.length - 1;
          const beforeSelf = sentBeforeImages + index;
          stage = images.length > 1 ? `图片 ${index + 1}/${images.length}` : "图片";
          await adapter.stage(eligibility.attemptKey, "image_started",
            { index: index + 1, total: images.length });
          await adapter.sendImage(images[index], eligibility.anchor, mode, index);
          if (!(await adapter.confirmImage(eligibility.anchor))) {
            const label = images.length > 1 ? `第 ${index + 1}/${images.length} 张图片` : "图片";
            throw new Error(action === "image" ? `无法确认${label}已发送，请检查消息流` :
              `无法确认${label}已发送；已停止话术发送，请检查消息流`);
          }
          await adapter.stage(eligibility.attemptKey, "image_sent",
            { index: index + 1, total: images.length, isLast, willSendText: isLast && needsText });
          if (!isLast || needsText) {
            await adapter.delay(IMAGE_INTERVAL_MS);
            const after = await assertTarget();
            const sent = ownMessages(after);
            if (mode === "auto") {
              const attached = sent.slice(sentBeforeImages);
              if (after.messages.some((item) => item.direction === "unknown" || item.kind === "unknown") ||
                  attached.length !== index + 1 ||
                  attached.some((item) => item.kind !== "image")) {
                throw new Error(images.length > 1 ?
                  `等待后会话不再是招呼加 ${index + 1} 张图片；已停止后续发送，请核对消息流` :
                  "等待后会话不再是招呼加一张图片；图片已发送，话术未发，请核对消息流");
              }
            } else if (sent.length !== beforeSelf + 1 || sent.at(-1)?.kind !== "image") {
              throw new Error("等待后已发消息不止新增一张图片；图片已发送，话术未发，请核对消息流");
            }
          }
        }
        if (!needsText) {
          await adapter.stage(eligibility.attemptKey, "image_only_complete");
          return { ok: true, stage: "完成", reason: images.length > 1 ?
            `${images.length} 张简历图片已发送` : "简历图片已发送" };
        }
      }

      stage = "话术";
      let expected = ownMessages(await assertTarget());
      for (let index = 0; index < messages.length; index += 1) {
        if (index > 0) await adapter.delay(500);
        const current = ownMessages(await assertTarget());
        if (!sameSent(expected, current)) throw new Error("等待期间出现新的已发消息，已停止后续话术");
        const message = messages[index];
        if (messages.length > 1) {
          stage = `话术 ${index + 1}/${messages.length}`;
          await adapter.stage(eligibility.attemptKey, "text_started", { index: index + 1, total: messages.length });
        }
        if (!sameSent(expected, ownMessages(await assertTarget()))) {
          throw new Error("发送前出现新的已发消息，已停止后续话术");
        }
        await adapter.sendText(message, eligibility.anchor);
        if (!(await adapter.confirmText(eligibility.anchor, message))) {
          throw new Error(`第 ${index + 1} 段话术发送结果未确认，可能已发送；请检查消息流，后续段落已停止`);
        }
        textSent += 1;
        if (index < messages.length - 1) {
          const confirmed = ownMessages(await assertTarget());
          if (confirmed.length !== expected.length + 1 ||
              !sameSent(expected, confirmed.slice(0, -1)) ||
              confirmed.at(-1)?.kind !== "text" || clean(confirmed.at(-1)?.text) !== clean(message)) {
            throw new Error("已发消息与已确认话术不一致，停止后续段落");
          }
          expected = confirmed;
        }
      }
      await adapter.stage(eligibility.attemptKey, action === "text" ? "text_only_complete" : "complete");
      return { ok: true, stage: "完成", reason: action === "text" ? "个人优势文字已发送" :
        images.length > 1 ? `${images.length} 张简历图片和话术均已发送` : "图片和话术均已发送" };
    } catch (error) {
      return { ok: false, stage, textSent, textTotal,
        reason: (textSent ? `已确认发送 ${textSent}/${textTotal} 段；` : "") + String(error?.message || error) };
    }
  }

  return { extractIdentity, assess, assessManual, sameAnchor, newChatCandidates,
    confirmOpenedConversation, textSequence, run };
});
