"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractIdentity, assess, assessManual, sameAnchor, newChatCandidates,
  confirmOpenedConversation, run } = require("../extension/first_contact_core.js");

function selectorScope(values) {
  return {
    querySelector(selector) {
      const value = values[selector];
      return value ? { textContent: value, getAttribute: () => "" } : null;
    },
  };
}

function snapshot(messages = [{ direction: "self", kind: "text", text: "您好", id: "100000000000001" }]) {
  return {
    security: false,
    controlsReady: true,
    conversationId: "conversation-1",
    identity: { company: "示例公司", hr: "测试HR乙", job: "产品经理" },
    messages,
  };
}

test("只有一条已发送的打招呼文字可视为首次接触", () => {
  const result = assess(snapshot());
  assert.equal(result.ok, true);
  assert.match(result.attemptKey, /100000000000001/);
});

test("会话身份兼容新版顶部字段并从当前选中列表项补全公司HR", () => {
  const root = selectorScope({
    ".top-info-content [class*=recruiter-name]": "测试HR戊",
    ".chat-position-content [class*=job-title]": "AI产品经理",
  });
  const selected = selectorScope({ ".name-box > span:nth-of-type(2)": "示例科技" });
  assert.deepEqual(extractIdentity(root, selected), {
    company: "示例科技", hr: "测试HR戊", job: "AI产品经理",
  });
});

test("第二条自发消息、图片和未知消息阻止发送", () => {
  const first = snapshot().messages[0];
  for (const extra of [
    { direction: "self", kind: "text", text: "补充一下", id: "3" },
    { direction: "self", kind: "image", text: "", id: "4" },
    { direction: "unknown", kind: "unknown", text: "", id: "5" },
    { direction: "system", kind: "system", text: "附件简历已发送", id: "6" },
  ]) {
    assert.equal(assess(snapshot([first, extra])).ok, false);
  }
});

test("对方回复和普通系统提示不改变首次接触判断", () => {
  const messages = [{ direction: "self", kind: "text", text: "你好", id: "100000000000001" },
    { direction: "friend", kind: "text", text: "可以聊聊", id: "friend-1" },
    { direction: "system", kind: "system", text: "请注意隐私保护", id: "system-1" }];
  assert.equal(assess(snapshot(messages)).ok, true);
});

test("缺少锚定信息、消息 ID、控件或出现验证页时拒绝", () => {
  const cases = [
    { ...snapshot(), identity: { company: "", hr: "测试HR乙", job: "产品经理" } },
    snapshot([{ direction: "self", kind: "text", text: "您好", id: "" }]),
    { ...snapshot(), controlsReady: false },
    { ...snapshot(), security: true },
    { ...snapshot(), messages: [] },
  ];
  cases.forEach((item) => assert.equal(assess(item).ok, false));
});

test("会话锚定同时核对公司、HR、岗位和首条消息 ID", () => {
  const base = snapshot();
  const anchor = assess(base).anchor;
  assert.equal(sameAnchor(base, anchor), true);
  assert.equal(sameAnchor({ ...base, identity: { ...base.identity, company: "别的公司" } }, anchor), false);
  assert.equal(sameAnchor({ ...base, messages: [{ ...base.messages[0], id: "other" }] }, anchor), false);
});

test("只把消息列表顶部新增的会话作为自动检查候选", () => {
  const before = [{ key: "旧会话", message: "您好", ownMessage: true, atTop: true }];
  const after = [
    { key: "新会话", message: "你好", ownMessage: true, atTop: true },
    { key: "旧会话", message: "您好", ownMessage: true, atTop: true },
    { key: "滚动加载的旧会话", message: "你好", ownMessage: true, atTop: false },
  ];
  assert.deepEqual(newChatCandidates(before, after), ["新会话"]);
  assert.deepEqual(newChatCandidates(after, after), []);
  assert.deepEqual(newChatCandidates(before, [
    { key: "新会话已回复", message: "可以聊聊", ownMessage: false, atTop: true },
    ...before,
  ]), ["新会话已回复"]);
});

test("旧会话预览变化不触发；新增聊天窗口须有消息预览", () => {
  const before = [{ key: "会话", message: "旧消息", ownMessage: false, atTop: true }];
  assert.deepEqual(newChatCandidates(before, [{ key: "会话", message: "你好", ownMessage: true, atTop: true }]), []);
  assert.deepEqual(newChatCandidates(before, [{ key: "会话", message: "收到", ownMessage: false, atTop: true }]), []);
  assert.deepEqual(newChatCandidates(before, [{ key: "新会话", message: "", ownMessage: false, atTop: true }]), []);
  assert.deepEqual(newChatCandidates(before, [{ key: "新会话", message: "你好", ownMessage: true, atTop: true }]), ["新会话"]);
});

test("新会话确认不依赖 URL 变化或列表预览与最后一条消息相同", () => {
  const row = { company: "示例公司", hr: "测试HR乙", message: "[新消息]" };
  const current = { ...snapshot(), conversationId: "unchanged" };
  assert.equal(confirmOpenedConversation(row, current).ok, true);
  assert.match(confirmOpenedConversation(null, current).reason, /列表项/);
  assert.match(confirmOpenedConversation({ ...row, company: "别的公司" }, current).reason, /不一致/);
  assert.match(confirmOpenedConversation(row, { ...current, messages: [] }).reason, /消息尚未加载/);
  assert.match(confirmOpenedConversation(row, { ...current, controlsReady: false }).reason, /控件尚未加载/);
});

test("手动模式跳过首次接触和身份字段限制，仍要求控件及会话标识", () => {
  const history = snapshot([
    { direction: "self", kind: "text", text: "你好", id: "first" },
    { direction: "friend", kind: "text", text: "好的", id: "reply" },
    { direction: "self", kind: "image", text: "", id: "old-image" },
  ]);
  const result = assessManual(history);
  assert.equal(result.ok, true);
  assert.equal(sameAnchor(history, result.anchor), true);
  assert.equal(assessManual(snapshot([])).ok, true);
  const missingCompany = assessManual({ ...history, identity: { ...history.identity, company: "" } });
  assert.equal(missingCompany.ok, true);
  assert.equal(assessManual({ ...history, controlsReady: false }).ok, false);
  assert.equal(assessManual({ ...snapshot([]), conversationId: "", selectedConversationKey: "" }).ok, false);
  const beforeMessagesLoad = snapshot([]);
  const beforeMessagesAnchor = assessManual(beforeMessagesLoad).anchor;
  assert.equal(sameAnchor(snapshot(), beforeMessagesAnchor), true);
});

test("单独发送只要求对应的图片或文字控件就绪", () => {
  const onlyText = { ...snapshot(), controlsReady: false,
    textControlsReady: true, imageControlsReady: false };
  const onlyImage = { ...snapshot(), controlsReady: false,
    textControlsReady: false, imageControlsReady: true };
  assert.equal(assessManual(onlyText, "text").ok, true);
  assert.equal(assessManual(onlyText, "image").ok, false);
  assert.equal(assessManual(onlyImage, "image").ok, true);
  assert.equal(assessManual(onlyImage, "text").ok, false);
});

test("手动点击发送图片和文字时不等待公司HR岗位身份", async () => {
  const a = adapter();
  a.read = async () => {
    a.calls.push("read");
    return { ...a.state.current, identity: { company: "", hr: "", job: "" } };
  };
  const result = await run(a, { mode: "manual", action: "both" });
  assert.equal(result.ok, true);
  assert.equal(a.calls.includes("sendImage"), true);
  assert.equal(a.calls.includes("sendText"), true);
  assert.equal(a.calls.includes("delay:250"), false);
});

function adapter(options = {}) {
  const calls = [];
  const base = snapshot();
  const state = { current: base, claimed: false };
  const impl = {
    calls, state,
    read: async () => { calls.push("read"); return state.current; },
    settings: async () => { calls.push("settings"); return { resume: { exists: true }, advantage_message: "测试文字A" }; },
    image: async () => { calls.push("image"); return { file: true }; },
    claim: async () => { calls.push("claim"); if (state.claimed) return false; state.claimed = true; return true; },
    stage: async (_key, name) => { calls.push(name); },
    sendImage: async () => { calls.push("sendImage"); },
    confirmImage: async () => {
      calls.push("confirmImage");
      state.current = snapshot([...state.current.messages,
        { direction: "self", kind: "image", text: "", id: "image-1" }]);
      return true;
    },
    sendText: async () => { calls.push("sendText"); },
    confirmText: async () => { calls.push("confirmText"); return true; },
    delay: async (ms) => { calls.push(`delay:${ms}`); },
  };
  Object.assign(impl, options);
  return impl;
}

test("正常流程严格按图片确认后再发话术", async () => {
  const a = adapter();
  assert.equal((await run(a)).ok, true);
  assert.deepEqual(a.calls.filter((x) => !["read", "settings", "image", "claim"].includes(x)), [
    "image_started", "sendImage", "confirmImage", "image_sent", "delay:500",
    "sendText", "confirmText", "complete",
  ]);
});

test("自动打开的新会话等待身份和首条招呼加载后再发送", async () => {
  const a = adapter();
  let reads = 0;
  a.read = async () => {
    a.calls.push("read");
    reads += 1;
    if (reads === 1) return { ...a.state.current,
      identity: { company: "", hr: "测试HR乙", job: "" }, messages: [] };
    if (reads === 2) return snapshot([]);
    return a.state.current;
  };
  const result = await run(a);
  assert.equal(result.ok, true);
  assert.equal(a.calls.filter((call) => call === "delay:250").length, 2);
  assert.equal(a.calls.includes("sendImage"), true);
  assert.equal(a.calls.includes("sendText"), true);
});

test("手动仅发图片不读取或发送文字", async () => {
  const a = adapter({ settings: async () => {
    a.calls.push("settings");
    return { resume: { exists: true }, advantage_message: "" };
  } });
  const result = await run(a, { mode: "manual", action: "image" });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "简历图片已发送");
  assert.equal(a.calls.includes("sendImage"), true);
  assert.equal(a.calls.includes("sendText"), false);
  assert.equal(a.calls.some((call) => call.startsWith("delay:")), false);
  assert.equal(a.calls.includes("image_only_complete"), true);
});

test("手动仅发文字不要求图片配置且不上传图片", async () => {
  const a = adapter({ settings: async () => {
    a.calls.push("settings");
    return { resume: { exists: false }, advantage_message: "测试文字A" };
  } });
  const result = await run(a, { mode: "manual", action: "text" });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "个人优势文字已发送");
  assert.equal(a.calls.includes("image"), false);
  assert.equal(a.calls.includes("sendImage"), false);
  assert.equal(a.calls.includes("sendText"), true);
  assert.equal(a.calls.some((call) => call.startsWith("delay:")), false);
  assert.equal(a.calls.includes("text_only_complete"), true);
});

test("图片结果未知时不发送话术，重复点击也不重发", async () => {
  const a = adapter({ confirmImage: async () => { a.calls.push("confirmImage"); return false; } });
  const first = await run(a);
  const second = await run(a);
  assert.equal(first.ok, false);
  assert.match(first.reason, /无法确认图片/);
  assert.equal(second.ok, false);
  assert.equal(a.calls.filter((x) => x === "sendImage").length, 1);
  assert.equal(a.calls.includes("sendText"), false);
});

test("图片后切换会话时不发送话术", async () => {
  const a = adapter({ confirmImage: async () => {
    a.calls.push("confirmImage");
    a.state.current = { ...snapshot(), identity: { ...snapshot().identity, hr: "测试HR丙" } };
    return true;
  } });
  const result = await run(a);
  assert.equal(result.ok, false);
  assert.match(result.reason, /会话已切换/);
  assert.equal(a.calls.includes("sendText"), false);
});

test("等待 0.5 秒后重新确认会话，切换目标就不发话术", async () => {
  const a = adapter({ delay: async (ms) => {
    a.calls.push(`delay:${ms}`);
    a.state.current = { ...a.state.current,
      identity: { ...a.state.current.identity, company: "另一家公司" } };
  } });
  const result = await run(a);
  assert.equal(result.ok, false);
  assert.match(result.reason, /会话已切换/);
  assert.equal(a.calls.includes("delay:500"), true);
  assert.equal(a.calls.includes("sendText"), false);
});

test("手动模式等待期间自己又发消息时停止话术，收到回复仍可继续", async () => {
  const extra = adapter({ delay: async () => {
    extra.state.current = snapshot([...extra.state.current.messages,
      { direction: "self", kind: "text", text: "补充说明", id: "self-extra" }]);
  } });
  const stopped = await run(extra, { mode: "manual" });
  assert.equal(stopped.ok, false);
  assert.match(stopped.reason, /等待后/);
  assert.equal(extra.calls.includes("sendText"), false);

  const reply = adapter({ delay: async () => {
    reply.state.current = snapshot([...reply.state.current.messages,
      { direction: "friend", kind: "text", text: "好的", id: "reply-1" }]);
  } });
  assert.equal((await run(reply, { mode: "manual" })).ok, true);
  assert.equal(reply.calls.includes("sendText"), true);
});

test("图片消息确认后平台更新其 ID，不误判为新发消息", async () => {
  for (const mode of ["auto", "manual"]) {
    const a = adapter({ delay: async (ms) => {
      a.calls.push(`delay:${ms}`);
      a.state.current = snapshot(a.state.current.messages.map((item) =>
        item.kind === "image" ? { ...item, id: "image-server-id" } : item));
    } });
    const result = await run(a, { mode });
    assert.equal(result.ok, true, mode);
    assert.equal(a.calls.includes("sendText"), true);
  }
});

test("图片临时节点消失后只剩一张图片时继续；两张持续存在则停止", async () => {
  for (const mode of ["auto", "manual"]) {
    const transient = adapter({
      confirmImage: async () => {
        transient.state.current = snapshot([...transient.state.current.messages,
          { direction: "self", kind: "image", text: "", id: "temp-image" },
          { direction: "self", kind: "image", text: "", id: "server-image" }]);
        return true;
      },
      delay: async () => {
        transient.state.current = snapshot(transient.state.current.messages.filter((item) =>
          item.id !== "temp-image"));
      },
    });
    assert.equal((await run(transient, { mode })).ok, true, mode);

    const duplicate = adapter({ confirmImage: async () => {
      duplicate.state.current = snapshot([...duplicate.state.current.messages,
        { direction: "self", kind: "image", text: "", id: "image-1" },
        { direction: "self", kind: "image", text: "", id: "image-2" }]);
      return true;
    } });
    assert.equal((await run(duplicate, { mode })).ok, false, mode);
    assert.equal(duplicate.calls.includes("sendText"), false);
  }
});

test("读取配置期间自己又发送消息时不发送图片", async () => {
  const a = adapter({ image: async () => {
    a.state.current = snapshot([...snapshot().messages,
      { direction: "self", kind: "text", text: "手动补充", id: "self-2" }]);
    return { file: true };
  } });
  const result = await run(a);
  assert.equal(result.ok, false);
  assert.equal(a.calls.includes("claim"), false);
  assert.equal(a.calls.includes("sendImage"), false);
});

test("图片确认后出现其他消息时不发送话术", async () => {
  const a = adapter({ confirmImage: async () => {
    a.state.current = snapshot([...snapshot().messages,
      { direction: "self", kind: "image", text: "", id: "image-1" },
      { direction: "self", kind: "text", text: "手动补充", id: "text-2" }]);
    return true;
  } });
  const result = await run(a);
  assert.equal(result.ok, false);
  assert.equal(a.calls.includes("sendText"), false);
});

test("图片发送期间对方回复仍继续发送话术", async () => {
  const a = adapter({ confirmImage: async () => {
    a.state.current = snapshot([...snapshot().messages,
      { direction: "friend", kind: "text", text: "你好", id: "friend-1" },
      { direction: "self", kind: "image", text: "", id: "image-1" }]);
    return true;
  } });
  assert.equal((await run(a)).ok, true);
  assert.equal(a.calls.includes("sendText"), true);
});

test("缺少配置时不创建发送尝试", async () => {
  const a = adapter({ settings: async () => ({ resume: { exists: false }, advantage_message: "测试文字A" }) });
  assert.equal((await run(a)).ok, false);
  assert.equal(a.calls.includes("claim"), false);
});

test("平台图片控件不接受 WebP，发送前停止", async () => {
  const a = adapter({ settings: async () => ({ resume: { exists: true, mime: "image/webp" }, advantage_message: "测试文字A" }) });
  const result = await run(a);
  assert.equal(result.ok, false);
  assert.match(result.reason, /JPG\/PNG/);
  assert.equal(a.calls.includes("claim"), false);
});

test("手动按钮可在已有历史和尝试标记时重复发送整套内容", async () => {
  const a = adapter();
  a.state.current = snapshot([
    { direction: "self", kind: "text", text: "你好", id: "100000000000001" },
    { direction: "friend", kind: "text", text: "可以", id: "friend-1" },
    { direction: "self", kind: "text", text: "此前已发过话术", id: "old-text" },
  ]);
  a.state.claimed = true;
  assert.equal((await run(a, { mode: "manual" })).ok, true);
  assert.equal((await run(a, { mode: "manual" })).ok, true);
  assert.equal(a.calls.filter((call) => call === "sendImage").length, 2);
  assert.equal(a.calls.filter((call) => call === "sendText").length, 2);
  assert.equal(a.calls.includes("claim"), false);
});

test("手动发送期间切换会话仍然停止", async () => {
  const a = adapter({ confirmImage: async () => {
    a.state.current = snapshot([
      { direction: "self", kind: "text", text: "您好", id: "other-conversation-first" },
    ]);
    return true;
  } });
  const result = await run(a, { mode: "manual" });
  assert.equal(result.ok, false);
  assert.equal(a.calls.includes("sendText"), false);
});
