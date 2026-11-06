(function () {
  "use strict";

  const core = globalThis.BTFirstContact;
  if (!core || !/\/web\/geek\/chat/.test(location.pathname)) return;

  const panel = document.createElement("section");
  panel.id = "bt-first-contact";
  panel.innerHTML = `<strong>首次接触 · 自动沟通</strong>
    <p id="bt-target">请打开你刚打招呼的会话</p>
    <div class="bt-actions">
      <button id="bt-send" type="button">发送图片和文字</button>
      <div class="bt-action-row">
        <button id="bt-send-image" type="button">仅发图片</button>
        <button id="bt-send-text" type="button">仅发文字</button>
      </div>
    </div>
    <p id="bt-status" role="status">自动处理新会话；三个手动按钮均可针对当前会话使用。</p>
    <a href="http://127.0.0.1:8787/first-contact-settings.html" target="_blank" rel="noopener noreferrer">配置图片和话术</a>`;
  document.body.appendChild(panel);
  const button = panel.querySelector("#bt-send");
  const imageButton = panel.querySelector("#bt-send-image");
  const textButton = panel.querySelector("#bt-send-text");
  const actionButtons = [button, imageButton, textButton];
  const target = panel.querySelector("#bt-target");
  const status = panel.querySelector("#bt-status");
  let running = false;
  let refreshTimer = 0;
  let seenRows = null;
  let baselineTimer = 0;
  let baselineSignature = "";
  let baselineStartedAt = 0;
  let activeRowKey = "";
  const handledRows = new Set();
  const pendingRows = [];

  function security() {
    return /验证|404/.test(document.title) ||
      !!document.querySelector("[class*=security-verify], [class*=captcha]");
  }

  function ownMessages(root) {
    return [...root.querySelectorAll(".im-list .message-item.item-myself")];
  }

  function describeMessage(node) {
    const direction = node.classList.contains("item-myself") ? "self" :
      node.classList.contains("item-friend") ? "friend" :
        node.classList.contains("item-system") ? "system" : "unknown";
    const text = String(direction === "system" ? node.textContent : node.querySelector(".text-content")?.textContent || "").trim();
    const media = !!node.querySelector(".message-content img, .message-content .image-content");
    const kind = direction === "system" ? "system" : media ? "image" : text ? "text" : "unknown";
    return { direction, kind, text, id: node.getAttribute("data-mid") || "" };
  }

  function read() {
    const root = document.querySelector(".chat-conversation");
    if (!root) return { security: security(), identity: {}, messages: [], controlsReady: false };
    const selectedRow = document.querySelector(
      ".user-list-content .friend-content.selected, " +
      ".user-list-content .friend-content.active, .user-list-content li.selected, " +
      ".user-list-content li.active, .user-list-content [aria-selected=true]");
    const selectedValue = (selector) => String(selectedRow?.querySelector(selector)?.textContent || "")
      .replace(/\s+/g, " ").trim();
    const selectedAvatar = selectedRow?.querySelector(".figure img")?.getAttribute("src") || "";
    const selectedConversationKey = [selectedValue(".name-box .name-text"),
      selectedValue(".name-box > span:nth-of-type(2)"), selectedAvatar].filter(Boolean).join("\u001f");
    return {
      security: security(),
      identity: core.extractIdentity(root, selectedRow),
      conversationId: new URLSearchParams(location.search).get("id") || "",
      selectedConversationKey,
      messages: [...root.querySelectorAll(".im-list .message-item")].map(describeMessage),
      textControlsReady: !!(root.querySelector("#chat-input") && root.querySelector(".btn-send")),
      imageControlsReady: !!root.querySelector('.btn-sendimg input[type="file"]'),
      controlsReady: !!(root.querySelector("#chat-input") && root.querySelector(".btn-send") &&
        root.querySelector('.btn-sendimg input[type="file"]')),
    };
  }

  function assertAnchor(anchor) {
    if (!core.sameAnchor(read(), anchor)) throw new Error("当前会话已切换或进入验证页，发送已停止");
  }

  function refreshTarget() {
    if (running) return;
    const snapshot = read();
    const { company, hr, job } = snapshot.identity;
    target.textContent = company || hr || job ?
      `${company || "公司未识别"} · ${hr || "HR未识别"} · ${job || "岗位未识别"}` :
      "请打开你刚打招呼的会话";
  }

  function show(message, error = false) {
    status.textContent = message;
    status.classList.toggle("bt-error", error);
  }

  async function api(path, responseType) {
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: "tracker:api", path, method: "GET", responseType });
    } catch (_error) {
      throw new Error("扩展连接已断开，请刷新消息页并确认本地服务正在运行");
    }
    if (!response?.ok) throw new Error(response?.error || "本地服务未启动");
    return response.data;
  }

  function waitFor(test, timeoutMs) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        try {
          if (test()) return resolve(true);
          if (Date.now() - start >= timeoutMs) return resolve(false);
          setTimeout(tick, 250);
        } catch (error) { reject(error); }
      };
      tick();
    });
  }

  async function claim(key) {
    const response = await chrome.runtime.sendMessage({ type: "tracker:claim", key });
    if (!response?.ok) throw new Error(response?.error || "无法保存发送尝试，已停止");
    return response.claimed;
  }

  async function stage(key, name, details = {}) {
    await chrome.storage.local.set({ [key]: { stage: name, at: Date.now() } });
    if (name === "image_started") show("正在发送简历图片…");
    if (name === "image_sent") show(details.willSendText ?
      "图片已确认，等待 0.5 秒后发送文字…" : "简历图片已确认发送。");
  }

  async function image() {
    const binary = await api("/api/resume", "binary");
    const raw = atob(binary.data);
    const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
    const settings = await api("/api/settings");
    return new File([bytes], settings.resume.name || "resume.jpg", {
      type: binary.mime || settings.resume.mime || "image/jpeg", lastModified: Date.now(),
    });
  }

  let beforeImageIds = new Set();
  async function sendImage(file, anchor, mode) {
    assertAnchor(anchor);
    if (mode === "auto" && !core.assess(read()).ok) {
      throw new Error("会话不再符合自动发送条件，图片发送已停止");
    }
    const root = document.querySelector(".chat-conversation");
    const input = root?.querySelector('.btn-sendimg input[type="file"]');
    if (!input) throw new Error("图片发送控件已消失");
    beforeImageIds = new Set(ownMessages(root).map((node) => node.getAttribute("data-mid")));
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function confirmImage(anchor) {
    return waitFor(() => {
      assertAnchor(anchor);
      const root = document.querySelector(".chat-conversation");
      return ownMessages(root).some((node) => {
        const id = node.getAttribute("data-mid");
        return id && !beforeImageIds.has(id) && describeMessage(node).kind === "image";
      });
    }, 20000);
  }

  let beforeTextIds = new Set();
  async function sendText(message, anchor) {
    assertAnchor(anchor);
    const root = document.querySelector(".chat-conversation");
    const input = root?.querySelector("#chat-input");
    const send = root?.querySelector(".btn-send");
    if (!input || !send) throw new Error("文字输入控件已消失");
    if (input.textContent.trim()) throw new Error("输入框已有未发送草稿；已停止，避免覆盖你的文字");
    beforeTextIds = new Set(ownMessages(root).map((node) => node.getAttribute("data-mid")));
    input.focus();
    if (!document.execCommand("insertText", false, message)) {
      input.textContent = message;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: message }));
    }
    const comparable = (value) => String(value || "").replace(/\s+/g, " ").trim();
    if (comparable(input.textContent) !== comparable(message)) throw new Error("话术未能正确写入输入框，已停止");
    const ready = await waitFor(() => !send.classList.contains("disabled") && !send.disabled, 5000);
    if (!ready) throw new Error("发送按钮未就绪；话术留在输入框，请手动检查");
    assertAnchor(anchor);
    send.click();
  }

  async function confirmText(anchor, message) {
    return waitFor(() => {
      assertAnchor(anchor);
      const root = document.querySelector(".chat-conversation");
      return ownMessages(root).some((node) => {
        const id = node.getAttribute("data-mid");
        const comparable = (value) => String(value || "").replace(/\s+/g, " ").trim();
        return id && !beforeTextIds.has(id) && comparable(describeMessage(node).text) === comparable(message);
      });
    }, 12000);
  }

  function listRows() {
    const list = document.querySelector(".user-list-content");
    if (!list) return [];
    const nearTop = list.scrollTop < 80;
    const groups = [...list.querySelectorAll('ul[role="thead"], ul[role="group"]')];
    return groups.flatMap((group) => {
      const atGroupTop = parseFloat(group.style.paddingTop || "0") < 80;
      return [...group.children].filter((node) => node.matches("li")).map((row, index) => {
        const value = (selector) => String(row.querySelector(selector)?.textContent || "").replace(/\s+/g, " ").trim();
        const hr = value(".name-box .name-text");
        const company = value(".name-box > span:nth-of-type(2)");
        const avatar = row.querySelector(".figure img")?.getAttribute("src") || "";
        return {
          row,
          key: hr && company ? [hr, company, avatar].join("\u001f") : "",
          hr, company,
          message: value(".last-msg-text"),
          ownMessage: !!row.querySelector(".last-msg .message-status"),
          atTop: nearTop && atGroupTop && index < 3,
        };
      });
    });
  }

  function rowSelected(row) {
    return row.matches(".selected, .active, [aria-selected=true]") ||
      !!row.querySelector(".friend-content.selected, .friend-content.active, [aria-selected=true]");
  }

  async function openNewConversation(candidate) {
    const draft = document.querySelector(".chat-conversation #chat-input");
    if (draft?.textContent.trim()) throw new Error("当前会话有未发送草稿，已保留草稿并停止自动切换");
    const item = listRows().find((entry) => entry.key === candidate.key);
    if (!item) throw new Error("新会话已从列表消失，请手动打开");
    const clickTarget = item.row.querySelector(".friend-content");
    if (!clickTarget) throw new Error("新会话列表项无法点击");
    clickTarget.click();
    let stable = 0;
    let lastSignature = "";
    let lastReason = "会话仍在加载";
    const opened = await waitFor(() => {
      const selected = listRows().find((entry) => entry.key === candidate.key &&
        rowSelected(entry.row));
      const snapshot = read();
      const check = core.confirmOpenedConversation(selected, snapshot);
      lastReason = check.reason || "会话仍在加载";
      const signature = [snapshot.identity.company, snapshot.identity.hr, snapshot.identity.job,
        snapshot.messages.length, snapshot.messages[0]?.id || "",
        snapshot.messages.at(-1)?.id || ""].join("\u001f");
      stable = check.ok && signature === lastSignature ? stable + 1 : check.ok ? 1 : 0;
      lastSignature = signature;
      return stable >= 2;
    }, 8000);
    if (!opened) throw new Error(`未能确认新会话已打开：${lastReason}。自动发送已停止`);
  }

  async function runFlow(mode, candidate = null, action = "both") {
    if (running) return;
    running = true;
    activeRowKey = candidate?.key || listRows().find((entry) =>
      rowSelected(entry.row))?.key || "";
    if (activeRowKey) handledRows.add(activeRowKey);
    actionButtons.forEach((item) => { item.disabled = true; });
    const manualStatus = action === "image" ? "正在向当前会话发送图片…" :
      action === "text" ? "正在向当前会话发送文字…" : "正在向当前会话发送图片和文字…";
    show(mode === "auto" ? "发现新会话，正在打开并检查…" : manualStatus);
    try {
      if (candidate) await openNewConversation(candidate);
      const result = await core.run({
        read, settings: () => api("/api/settings"), image, claim, stage,
        sendImage, confirmImage, sendText, confirmText,
        delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      }, { mode, action });
      show(result.reason, !result.ok);
    } catch (error) {
      show(String(error.message || error), true);
    } finally {
      running = false;
      activeRowKey = "";
      actionButtons.forEach((item) => { item.disabled = false; });
      refreshTarget();
      if (pendingRows.length) queueMicrotask(processNextRow);
    }
  }

  button.addEventListener("click", () => runFlow("manual", null, "both"));
  imageButton.addEventListener("click", () => runFlow("manual", null, "image"));
  textButton.addEventListener("click", () => runFlow("manual", null, "text"));

  function processNextRow() {
    if (running || !pendingRows.length) return;
    const next = pendingRows.shift();
    runFlow("auto", next);
  }

  function inspectRows() {
    const current = listRows();
    if (!current.length) {
      refreshTarget();
      return;
    }
    const summaries = current.map(({ row: _row, ...summary }) => summary);
    if (seenRows === null) {
      const signature = JSON.stringify(summaries.map((entry) =>
        [entry.key, entry.message, entry.ownMessage]));
      if (signature !== baselineSignature) {
        baselineSignature = signature;
        baselineStartedAt = Date.now();
      }
      clearTimeout(baselineTimer);
      if (Date.now() - baselineStartedAt < 2000) {
        baselineTimer = setTimeout(inspectRows, 2000);
        show("正在记录现有聊天列表；稍后开始监听新会话…");
        refreshTarget();
        return;
      }
      seenRows = new Map(summaries.map((entry) => [entry.key, entry]));
      show("正在监听新会话；手动按钮可针对当前会话重复发送。");
      refreshTarget();
      return;
    }
    const candidates = core.newChatCandidates([...seenRows.values()], summaries);
    for (const entry of summaries) {
      if (entry.key && (entry.message || seenRows.has(entry.key))) seenRows.set(entry.key, entry);
    }
    for (const key of candidates) {
      if (key === activeRowKey || handledRows.has(key) ||
          pendingRows.some((entry) => entry.key === key)) continue;
      const entry = current.find((item) => item.key === key);
      if (entry) pendingRows.push({ key, hr: entry.hr, company: entry.company, message: entry.message });
    }
    refreshTarget();
    processNextRow();
  }

  const observer = new MutationObserver((changes) => {
    if (changes.every((change) => panel.contains(change.target))) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(inspectRows, 300);
  });
  observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  inspectRows();
})();
