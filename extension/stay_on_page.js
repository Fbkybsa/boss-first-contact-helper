(function () {
  "use strict";

  const rules = globalThis.BTStayOnPage;
  const snapshotter = globalThis.BTJobSnapshot;
  const CHAT_PATH = /\/web\/geek\/chat(?:\/|$)/;
  const isChatPage = () => CHAT_PATH.test(location.pathname);
  if (!rules || !snapshotter || isChatPage()) return;

  const text = (node) => rules.clean(node?.textContent);
  const visible = (node) => {
    if (!node?.isConnected) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let current = node; current && current !== document.body; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" ||
          style.opacity === "0" || current.inert || current.getAttribute("aria-hidden") === "true") {
        return false;
      }
    }
    return true;
  };

  const tagName = (node) => String(node?.tagName || node?.tag || "").toLowerCase();
  const className = (node) => String(node?.className?.baseVal || node?.className || "");
  function enabled(node) {
    if (!visible(node) || node.disabled || node.getAttribute?.("aria-disabled") === "true") return false;
    return typeof node.click === "function";
  }

  function semanticAction(node) {
    if (!enabled(node)) return false;
    const tag = tagName(node);
    if (tag === "button" || tag === "a") return true;
    if (node.getAttribute?.("role") === "button") return true;
    if (node.getAttribute?.("tabindex") != null || typeof node.onclick === "function") return true;
    if (/(^|[\s_-])(btn|button)([\s_-]|$)/i.test(className(node))) return true;
    return getComputedStyle(node).cursor === "pointer";
  }

  function actionAncestor(node, root, accepted) {
    for (let current = node; current; current = current.parentElement) {
      if (accepted.has(text(current)) && semanticAction(current)) return current;
      if (current === root) break;
    }
    return null;
  }

  function exactNode(root, accepted) {
    const unique = new Set();
    for (const node of root.querySelectorAll("button, a, [role=button], [tabindex], div, span")) {
      if (!accepted.has(text(node)) || !visible(node)) continue;
      const action = actionAncestor(node, root, accepted);
      // BOSS also uses plain div/span labels whose click event bubbles to a
      // framework-managed parent without semantic attributes.  The complete
      // success-dialog triple is the safety boundary; keep the exact label as
      // a fallback when no semantic control can be identified.
      unique.add(action || node);
    }
    const hits = [...unique];
    hits.sort((a, b) => {
      const priority = (node) => tagName(node) === "button" ? 0 :
        node.getAttribute?.("role") === "button" ? 1 : tagName(node) === "a" ? 2 : 3;
      const order = priority(a) - priority(b);
      if (order) return order;
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.width * ar.height - br.width * br.height;
    });
    return hits[0] || null;
  }

  function findStayDialog() {
    const headings = [...document.querySelectorAll("h1, h2, h3, h4, strong, div, span, p")]
      .filter((node) => text(node) === "已向BOSS发送消息" && visible(node));
    for (const heading of headings) {
      let root = heading.parentElement;
      for (let depth = 0; root && depth < 8 && root !== document.body; depth += 1, root = root.parentElement) {
        if (!visible(root)) continue;
        const stay = exactNode(root, rules.stayLabels);
        const proceed = exactNode(root, new Set(["继续沟通"]));
        if (stay && proceed && rules.isStayDialog({
          title: heading.textContent, stay: stay.textContent, continueText: proceed.textContent,
        })) return { root, stay, heading };
      }
    }
    return null;
  }

  const handledRoots = new WeakSet();
  const processingRoots = new WeakSet();
  let timer = 0;
  function eventId() {
    const value = globalThis.crypto?.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `boss-contact:${value}`;
  }

  async function inspect() {
    const pathAtDetection = location.pathname;
    const dialog = findStayDialog();
    if (!dialog || handledRoots.has(dialog.root) || processingRoots.has(dialog.root)) return;
    processingRoots.add(dialog.root);
    const capturedAt = new Date().toISOString();
    let extracted;
    try {
      extracted = snapshotter.extract(document, globalThis, location);
    } catch (error) {
      extracted = {
        job: {}, action_label: "",
        capture: {
          status: "failed", missing_fields: ["job_snapshot"],
          warnings: [`extract_error:${String(error?.message || error)}`],
        },
      };
    }
    if (extracted.job?.hr?.activity_text) {
      extracted.job.hr.activity_captured_at = capturedAt;
    }

    let clicked = false;
    try {
      // URL can change before BOSS finishes rendering its navigation-choice
      // dialog. Re-find the exact live dialog instead of treating the route as
      // the source of truth. If the dialog was detached or redrawn, this pass
      // does nothing and a later mutation may retry safely.
      const current = findStayDialog();
      if (!current || current.root !== dialog.root || !enabled(current.stay)) {
        console.warn("BOSS留页点击已延后：发送成功弹窗在岗位快照提取期间发生变化");
        return;
      }
      current.stay.click();
      clicked = true;
      handledRoots.add(current.root);
      if (location.pathname !== pathAtDetection) {
        console.info("BOSS页面路由已变化，但已根据仍然有效的发送成功弹窗选择留在本页");
      }
    } finally {
      processingRoots.delete(dialog.root);
    }
    if (!clicked) return;
    const payload = {
      event_id: eventId(),
      source: "boss_stay_on_page",
      captured_at: capturedAt,
      action: {
        button_text: extracted.action_label || "",
        success_dialog: text(dialog.heading),
        stay_button_text: text(dialog.stay),
        stay_button_clicked: clicked,
      },
      job: extracted.job || {},
      capture: extracted.capture || {
        status: "failed", missing_fields: ["job_snapshot"], warnings: [],
      },
    };
    try {
      const response = await chrome.runtime.sendMessage({
        type: "tracker:contact-snapshot", payload,
      });
      if (!response?.ok) console.warn("BOSS岗位快照保存失败", response?.error || "未知错误");
    } catch (error) {
      console.warn("BOSS岗位快照未能提交给扩展后台", error);
    }
  }

  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(inspect, 100);
  });
  observer.observe(document.body, {
    childList: true, characterData: true, attributes: true,
    attributeFilter: ["class", "style", "aria-hidden"], subtree: true,
  });
  globalThis.addEventListener?.("pagehide", () => {
    clearTimeout(timer);
    observer.disconnect();
  }, { once: true });
  inspect();
})();
