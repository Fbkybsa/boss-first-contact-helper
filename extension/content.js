/**
 * BOSS直聘投递追踪 - 内容脚本（只读）。
 *
 * 职责：按 selectors.json 的配置，从当前已登录页面 DOM 读取可见信息，
 * 通过后台脚本转发到本地服务（127.0.0.1:8787）。
 * 红线：不点击、不输入、不发送消息；只有匹配已核实页面规则时才采集。
 */
const COLLECT_DEBOUNCE_MS = 2000;   // DOM 变化后的防抖
const MIN_INTERVAL_MS = 30000;      // 同一页面最短采集间隔

let config = null;
let pageRules = [];
let lastRun = 0;
let timer = null;
let scheduledForce = false;
let scheduledReason = "pageview";
const seenItems = new Map();

init().catch(() => {});

async function init() {
  try {
    config = await (await fetch(chrome.runtime.getURL("selectors.json"))).json();
  } catch (e) {
    config = { pages: [], pause_indicators: [] };
  }
  pageRules = (config.pages || []).filter((p) =>
    p.enabled !== false && new RegExp(p.url_pattern).test(location.href));
  if (!pageRules.length) return; // 当前页面不在采集范围内
  schedule("pageview");
  const observer = new MutationObserver(() => schedule("dom_change"));
  observer.observe(document.body, { childList: true, subtree: true });
}

function schedule(reason, force = false) {
  scheduledReason = reason || scheduledReason;
  scheduledForce = scheduledForce || force;
  clearTimeout(timer);
  const remaining = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRun));
  const delay = force ? COLLECT_DEBOUNCE_MS : Math.max(COLLECT_DEBOUNCE_MS, remaining);
  timer = setTimeout(() => {
    const runReason = scheduledReason;
    const runForce = scheduledForce;
    scheduledForce = false;
    scheduledReason = "dom_change";
    run(runReason, runForce);
  }, delay);
}

function paused() {
  // 验证码/安全验证/403 拦截页出现时立即停止采集
  // pause_indicators 条目：字符串=CSS选择器；{titleContains}=页面标题包含
  return (config.pause_indicators || []).some((ind) => {
    try {
      if (typeof ind === "string") return !!document.querySelector(ind);
      if (ind && ind.titleContains) return document.title.includes(ind.titleContains);
    } catch (e) { /* 单条配置异常不中断 */ }
    return false;
  });
}

async function run(reason, force = false) {
  if (!force && Date.now() - lastRun < MIN_INTERVAL_MS) {
    schedule(reason);
    return;
  }
  lastRun = Date.now();
  if (paused()) {
    chrome.runtime.sendMessage({
      type: "tracker:report",
      payload: { status: "paused", message: "检测到验证码/安全验证，采集已暂停", source: location.href },
    }).catch(() => {});
    return;
  }
  for (const rule of pageRules) await runRule(rule, reason, force);
}

async function runRule(rule, reason, force) {
  if (!pageConditionMatches(rule.page_when)) return;
  const nodes = document.querySelectorAll(rule.item_selector);
  const summary = extract(document, { fields: rule.summary_fields || {} });
  if (!nodes.length && !Object.keys(summary).length) return;
  const extracted = [...nodes].map((node) => extract(node, rule)).filter((it) =>
    it && (it.job_key || it.title || it.company_name));
  const items = extracted.filter((item) => {
    const itemKey = item.job_key || item.url || [
      item.company_name, item.title, item.hr && item.hr.name,
    ].filter(Boolean).join("#");
    const key = `${rule.page_type}:${itemKey}`;
    const signature = stableStringify(item);
    if (!force && seenItems.get(key) === signature) return false;
    item.__trackerKey = key;
    item.__trackerSignature = signature;
    return true;
  });
  if (!items.length && !Object.keys(summary).length) return;
  const tracking = items.map((item) => [item.__trackerKey, item.__trackerSignature]);
  for (const item of items) {
    delete item.__trackerKey;
    delete item.__trackerSignature;
  }
  try {
    const response = await chrome.runtime.sendMessage({
      type: "tracker:ingest",
      payload: {
        page_type: rule.page_type,
        captured_at: localIso(),
        source: reason,
        page_url: location.href,
        application: rule.application !== false,
        summary,
        items,
      },
    });
    if (response && response.ok) {
      for (const [key, signature] of tracking) seenItems.set(key, signature);
    } else {
      setTimeout(() => schedule("retry", true), MIN_INTERVAL_MS);
    }
  } catch (e) {
    setTimeout(() => schedule("retry", true), MIN_INTERVAL_MS);
  }
}

function extract(el, rule) {
  const item = {};
  for (const [name, spec] of Object.entries(rule.fields || {})) {
    try {
      let value;
      if (spec.when && !el.querySelector(spec.when)) continue;
      if (spec.unless && el.querySelector(spec.unless)) continue;
      if (spec.when_any && !spec.when_any.some((condition) => conditionMatches(el, condition))) continue;
      if (spec.unless_any && spec.unless_any.some((condition) => conditionMatches(el, condition))) continue;
      if (spec.value !== undefined) {
        value = spec.value;
      } else if (spec.from === "url") {
        value = location.href; // 如从 job_detail/xxx.html 提取职位ID
      } else {
        const matches = spec.selector ? el.querySelectorAll(spec.selector) : [el];
        const node = spec.pick === "last" ? matches[matches.length - 1] : matches[0];
        if (!node) continue;
        value = spec.attr && spec.attr !== "text" ? node.getAttribute(spec.attr) : node.textContent;
      }
      if (value == null) continue;
      value = String(value).trim();
      if (!value) continue;
      if (spec.regex) {
        const m = value.match(new RegExp(spec.regex));
        if (!m) continue;
        value = m[1] !== undefined ? m[1] : m[0];
      }
      value = String(value).trim();
      if (spec.absolute_url) value = new URL(value, location.origin).href;
      setNested(item, name, value);
    } catch (e) { /* 单字段失败不影响其它字段 */ }
  }
  return item;
}

function pageConditionMatches(condition) {
  if (!condition) return true;
  try {
    const node = document.querySelector(condition.selector);
    if (!node) return false;
    if (!condition.regex) return true;
    const value = condition.attr && condition.attr !== "text"
      ? node.getAttribute(condition.attr)
      : node.textContent;
    return new RegExp(condition.regex).test(String(value || "").trim());
  } catch (e) {
    return false;
  }
}

function conditionMatches(el, condition) {
  if (typeof condition === "string") return !!el.querySelector(condition);
  if (!condition || !condition.selector) return false;
  const node = el.querySelector(condition.selector);
  if (!node) return false;
  return !condition.regex || new RegExp(condition.regex).test(node.textContent || "");
}

function setNested(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = cur[parts[i]] || {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function localIso() {
  // "YYYY-MM-DD HH:mm:ss"，与服务端格式一致
  return new Date().toLocaleString("sv");
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "collect") {
    if (pageRules.length) schedule(msg.reason || "manual", true);
    sendResponse({ ok: true, scheduled: !!pageRules.length });
    return;
  }
  if (msg && msg.type === "tracker:save-sample") {
    const html = `<!doctype html>\n${document.documentElement.outerHTML}`;
    chrome.runtime.sendMessage({
      type: "tracker:sample",
      payload: {
        page_url: location.href,
        title: document.title,
        captured_at: localIso(),
        html,
      },
    }).then((response) => {
      if (response && response.ok && pageRules.length) schedule("saved_sample", true);
      sendResponse(response);
    }).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});
