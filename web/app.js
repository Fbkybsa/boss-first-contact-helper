"use strict";

const state = {
  q: "", stage: "", viewed: "", industry: "", company_size: "",
  date_from: "", date_to: "", salary_min_k: "",
  sort: "applied_at", order: "desc",
};
let meta = { stages: [], viewed: [], industries: [], company_sizes: [] };
let currentId = null;
let refreshTimer = null;
let periodLabel = "今天";

const $ = (sel) => document.querySelector(sel);

const STAGE_CHIP = {
  "已沟通": "s-chat", "已投递": "s-applied", "约面试": "s-interview", "已面试": "s-interviewed",
  "已获Offer": "s-offer", "已入职": "s-hired", "已拒绝": "s-rejected",
  "已撤回": "s-closed", "已结束": "s-closed",
};
const FIELD_LABEL = { stage: "招聘阶段", viewed: "查看状态", applied_at: "投递时间" };

const FILTER_BINDINGS = [
  ["f-q", "q"], ["f-stage", "stage"], ["f-viewed", "viewed"], ["f-industry", "industry"],
  ["f-size", "company_size"], ["f-from", "date_from"], ["f-to", "date_to"],
  ["f-salary", "salary_min_k"], ["f-sort", "sort"], ["f-order", "order"],
];

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

const patchOptions = (body) => ({
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const postOptions = (body) => ({
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

function queryString() {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(state)) {
    if (v !== "" && v != null) qs.set(k, v);
  }
  return qs.toString();
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const chip = (stage) => `<span class="chip ${STAGE_CHIP[stage] || ""}">${esc(stage)}</span>`;

function fmtLatency(hours, msgAt, replyAt) {
  if (hours == null) return msgAt && !replyAt ? "尚未回复" : "—";
  if (hours < 1) return `${Math.round(hours * 60)}分钟`;
  if (hours < 24) return `${hours.toFixed(1)}小时`;
  return `${(hours / 24).toFixed(1)}天`;
}

function toLocalInput(v) {
  if (!v) return "";
  const s = String(v).replace("T", " ");
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) return s.slice(0, 16).replace(" ", "T");
  return s.slice(0, 10) + "T00:00";
}
function fromLocalInput(v) {
  return v ? String(v).replace("T", " ") : "";
}

function localDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function applyPeriod(period, shouldRefresh = true) {
  const today = localDate();
  if (period === "today") {
    state.date_from = today;
    state.date_to = today;
    periodLabel = "今天";
  } else if (period === "7d") {
    state.date_from = localDate(-6);
    state.date_to = today;
    periodLabel = "近7天";
  } else if (period === "month") {
    state.date_from = `${today.slice(0, 8)}01`;
    state.date_to = today;
    periodLabel = "本月";
  } else if (period === "all") {
    state.date_from = "";
    state.date_to = "";
    periodLabel = "全部时间";
  } else {
    periodLabel = "自定义时间";
  }
  $("#f-period").value = period;
  $("#f-from").value = state.date_from;
  $("#f-to").value = state.date_to;
  if (shouldRefresh) refresh();
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

// ---- 元数据 / 主列表 -------------------------------------------------------

async function loadMeta() {
  meta = await api("/api/meta");
  const fill = (sel, values, allLabel) => {
    sel.innerHTML = `<option value="">${allLabel}</option>` +
      values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
  };
  fill($("#f-stage"), meta.stages, "全部阶段");
  fill($("#f-viewed"), meta.viewed, "全部查看状态");
  fill($("#f-industry"), meta.industries, "全部行业");
  fill($("#f-size"), meta.company_sizes, "全部规模");
  $("#d-stage").innerHTML = meta.stages.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
  $("#d-viewed").innerHTML = meta.viewed.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
}

async function refresh() {
  try {
    const data = await api("/api/applications?" + queryString());
    renderTable(data.items);
    $("#table-meta").textContent = `共 ${data.total} 条记录`;
    $("#btn-export").href = "/api/export.csv?" + queryString();
    const statsParams = new URLSearchParams({ stale_days: "7" });
    if (state.date_from) statsParams.set("date_from", state.date_from);
    if (state.date_to) statsParams.set("date_to", state.date_to);
    const s = await api("/api/stats?" + statsParams.toString());
    renderCards(s);
    $("#last-sync").textContent = s.last_sync
      ? `数据截至 ${s.last_sync.finished_at}（${s.last_sync.source}）`
      : "尚未同步任何数据";
  } catch (err) {
    toast("加载失败：" + err.message);
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 300);
}

function renderTable(rows) {
  const tbody = $("#tbl tbody");
  $("#empty").hidden = rows.length > 0;
  tbody.innerHTML = rows.map((r) => `
    <tr data-id="${r.id}">
      <td>
        <div class="cell-main">${esc(r.company_name) || "<i>未知公司</i>"}${r.attempt > 1 ? ` <span class="badge">第${r.attempt}次</span>` : ""}</div>
        <div class="cell-sub">${esc(r.title)}${r.city ? " · " + esc(r.city) : ""}</div>
      </td>
      <td>${esc(r.salary_raw) || "—"}</td>
      <td>${chip(r.stage)}</td>
      <td>${esc(r.viewed)}</td>
      <td>${esc(r.applied_at) || "<i>未知</i>"}</td>
      <td>${esc(r.last_change_at) || "—"}</td>
      <td>${esc(r.hr_activity) || "—"}</td>
      <td>${fmtLatency(r.reply_latency_hours, r.last_message_at, r.last_reply_at)}</td>
      <td class="note-cell" title="${esc(r.note)}">${r.note ? "●" : ""}</td>
    </tr>`).join("");
  tbody.querySelectorAll("tr").forEach((tr) =>
    tr.addEventListener("click", () => openDrawer(Number(tr.dataset.id))));
}

function renderCards(s) {
  const distEntries = Object.entries(s.distribution).filter(([, v]) => v > 0);
  const maxWeek = Math.max(1, ...s.weekly.map((w) => w.applied));
  const coverage = s.history_coverage;
  $("#cards").innerHTML = `
    <div class="card"><span class="num">${s.applied_total}</span><span class="lbl">${periodLabel}投递<br><span class="sub">按首次沟通时间</span></span></div>
    ${coverage ? `<div class="card"><span class="num">${coverage.tracked_applied_total}/${coverage.platform_applied_total}</span><span class="lbl">历史投递覆盖<br><span class="sub">还需补 ${coverage.remaining} 条明细</span></span></div>` : ""}
    <div class="card"><span class="num">${s.viewed_rate}%</span><span class="lbl">被查看率<br><span class="sub">${s.viewed_total} / ${s.applied_total}</span></span></div>
    <div class="card"><span class="num">${s.interview_conversion}%</span><span class="lbl">面试转化率<br><span class="sub">${s.interview_total} / ${s.applied_total}</span></span></div>
    <div class="card"><span class="num">${s.reply_rate}%</span><span class="lbl">回复率<br><span class="sub">${s.replied_total} / ${s.applied_total}</span></span></div>
    <div class="card"><span class="num">${s.stale_count}</span><span class="lbl">待跟进<br><span class="sub">超${s.stale_days}天未进展</span></span></div>
    <div class="card card-wide">
      <div class="lbl">${periodLabel}发生的事件</div>
      <div class="dist">
        <span class="chip s-chat">有沟通 ${s.period_activity.conversations}</span>
        ${s.period_activity.unclassified ? `<span class="chip s-closed">待确认是否投递 ${s.period_activity.unclassified}</span>` : ""}
        <span class="chip">被查看 ${s.period_activity.viewed}</span>
        <span class="chip">收到回复 ${s.period_activity.replied}</span>
        <span class="chip s-interview">进入面试 ${s.period_activity.interview}</span>
        <span class="chip s-rejected">被拒绝 ${s.period_activity.rejected}</span>
        ${s.scope.unknown_applied_time ? `<span class="chip s-closed">投递时间待确认 ${s.scope.unknown_applied_time}</span>` : ""}
      </div>
      <div class="lbl">各状态分布</div>
      <div class="dist">${distEntries.map(([k, v]) =>
        `<span class="chip ${STAGE_CHIP[k] || ""}">${esc(k)} ${v}</span>`).join("") || "<i>暂无</i>"}</div>
      <div class="lbl" style="margin-top:10px">近8周投递趋势（按真实投递时间，未补录时间的不计入）</div>
      <div class="bars">${s.weekly.map((w) =>
        `<div class="bar-col" title="${w.week}：${w.applied} 次"><div class="bar" style="height:${Math.max(2, Math.round(w.applied * 30 / maxWeek))}px;${w.applied ? "" : "background:transparent"}"></div><span class="bar-n">${w.applied || ""}</span></div>`).join("")}</div>
    </div>`;
}

// ---- 详情抽屉 ---------------------------------------------------------------

async function openDrawer(id) {
  try {
    currentId = id;
    const { application: a, events } = await api(`/api/applications/${id}`);
    $("#d-title").textContent = `${a.company_name || "未知公司"} · ${a.title || ""}`;
    $("#d-info").innerHTML = `
      <div>${chip(a.stage)} <span class="muted">查看：${esc(a.viewed)} · 第${a.attempt}次投递</span></div>
      <dl>
        <dt>薪酬</dt><dd>${esc(a.salary_raw) || "—"}</dd>
        <dt>行业 / 规模</dt><dd>${esc(a.industry) || "—"} / ${esc(a.company_size) || "—"}</dd>
        <dt>城市</dt><dd>${esc(a.city) || "—"}</dd>
        <dt>发送状态</dt><dd>${esc(a.send_status) || "—"}${a.send_error ? `<br>${esc(a.send_error)}` : ""}</dd>
        <dt>投递时间</dt><dd>${esc(a.applied_at) || "未知"}${a.applied_at ? `（来源：${esc(a.applied_at_source)}${a.applied_at_precision ? `，精度：${esc(a.applied_at_precision)}` : ""}）` : "，可人工补录"}</dd>
        <dt>最近消息 / 回复</dt><dd>${esc(a.last_message_at) || "—"} / ${esc(a.last_reply_at) || "—"}（观测值）</dd>
        <dt>HR</dt><dd>${esc(a.hr_name) || "—"}${a.hr_title ? " · " + esc(a.hr_title) : ""}${a.hr_activity ? " · " + esc(a.hr_activity) : ""}</dd>
        ${a.interview_at ? `<dt>面试时间</dt><dd>${esc(a.interview_at)}</dd>` : ""}
        ${a.url ? `<dt>链接</dt><dd><a href="${esc(a.url)}" target="_blank" rel="noopener">打开职位页</a></dd>` : ""}
      </dl>`;
    $("#d-stage").value = a.stage;
    $("#d-viewed").value = a.viewed;
    $("#d-applied").value = toLocalInput(a.applied_at);
    $("#d-interview").value = toLocalInput(a.interview_at);
    $("#d-note").value = a.note || "";
    $("#d-locked").checked = !!a.manual_locked;
    $("#d-events").innerHTML = events.map(renderEvent).join("") || "<i>暂无事件</i>";
    $("#d-events").querySelectorAll("[data-adopt]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        try {
          await api(`/api/applications/${id}`, patchOptions({ stage: btn.dataset.adopt }));
          toast(`已采纳为「${btn.dataset.adopt}」并开启人工保护`);
          await refresh();
          await openDrawer(id);
        } catch (err) { toast("采纳失败：" + err.message); }
      }));
    $("#drawer").hidden = false;
    $("#drawer-mask").hidden = false;
  } catch (err) {
    toast("加载详情失败：" + err.message);
  }
}

function renderEvent(ev) {
  const pending = ev.applied === 0;
  const adopt = pending && ev.new_value && meta.stages.includes(ev.new_value)
    ? `<button class="btn btn-small" data-adopt="${esc(ev.new_value)}">采纳</button>` : "";
  return `<div class="event ${pending ? "event-pending" : ""}">
    <div class="event-line">${esc(ev.occurred_at || ev.created_at)} · ${esc(FIELD_LABEL[ev.field] || ev.field)}：
      ${esc(ev.old_value ?? "—")} → ${esc(ev.new_value ?? "?")}
      ${pending ? '<span class="badge badge-warn">待确认</span>' : ""} ${adopt}</div>
    <div class="event-ev muted">依据：${esc(ev.evidence || "")}</div>
  </div>`;
}

function closeDrawer() {
  $("#drawer").hidden = true;
  $("#drawer-mask").hidden = true;
  currentId = null;
}

// ---- 图片与文字设置 -------------------------------------------------------

async function openSettings() {
  try {
    const s = await api("/api/settings");
    $("#s-advantage").value = s.advantage_message || "";
    $("#s-resume-status").textContent = s.resume?.exists
      ? `当前图片：${s.resume.name}（${Math.max(1, Math.round(s.resume.size / 1024))} KB）`
      : "尚未上传简历图片";
    $("#settings-panel").hidden = false;
    $("#settings-mask").hidden = false;
  } catch (err) {
    toast("加载设置失败：" + err.message);
  }
}

function closeSettings() {
  $("#settings-panel").hidden = true;
  $("#settings-mask").hidden = true;
  if (location.hash === "#settings") history.replaceState(null, "", location.pathname + location.search);
}

async function fileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("读取简历图片失败"));
    reader.readAsDataURL(file);
  });
}

async function saveSettings(event) {
  event.preventDefault();
  const button = event.submitter || $("#settings-form button[type=submit]");
  button.disabled = true;
  try {
    await api("/api/settings", patchOptions({
      advantage_message: $("#s-advantage").value,
    }));
    const file = $("#s-resume").files[0];
    if (file) {
      if (file.size > 8 * 1024 * 1024) throw new Error("简历图片需小于 8 MB");
      await api("/api/settings/resume", postOptions({
        filename: file.name,
        data_url: await fileDataUrl(file),
      }));
    }
    toast("设置已保存");
    await openSettings();
  } catch (err) {
    toast("保存失败：" + err.message);
  } finally {
    button.disabled = false;
  }
}

// ---- 事件绑定 ---------------------------------------------------------------

function bindUI() {
  $("#btn-settings").addEventListener("click", openSettings);
  $("#settings-close").addEventListener("click", closeSettings);
  $("#settings-mask").addEventListener("click", closeSettings);
  $("#settings-form").addEventListener("submit", saveSettings);
  $("#f-period").addEventListener("change", (e) => applyPeriod(e.target.value));
  for (const [id, key] of FILTER_BINDINGS) {
    const el = document.getElementById(id);
    const handler = () => {
      state[key] = key === "q" ? el.value.trim() : el.value;
      if (key === "date_from" || key === "date_to") {
        $("#f-period").value = "custom";
        periodLabel = "自定义时间";
      }
      scheduleRefresh();
    };
    el.addEventListener("input", handler);
    el.addEventListener("change", handler);
  }
  $("#btn-reset").addEventListener("click", () => {
    Object.assign(state, {
      q: "", stage: "", viewed: "", industry: "", company_size: "",
      date_from: "", date_to: "", salary_min_k: "", sort: "applied_at", order: "desc",
    });
    $("#f-period").value = "all";
    periodLabel = "全部时间";
    for (const [id, key] of FILTER_BINDINGS) document.getElementById(id).value = state[key];
    refresh();
  });
  $("#btn-sync").addEventListener("click", async () => {
    try { toast((await api("/api/sync/request", { method: "POST" })).message); }
    catch (err) { toast("请求失败：" + err.message); }
  });
  $("#d-close").addEventListener("click", closeDrawer);
  $("#drawer-mask").addEventListener("click", closeDrawer);
  $("#d-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentId) return;
    const body = {
      stage: $("#d-stage").value,
      viewed: $("#d-viewed").value,
      applied_at: fromLocalInput($("#d-applied").value),
      interview_at: fromLocalInput($("#d-interview").value),
      note: $("#d-note").value,
      manual_locked: $("#d-locked").checked,
    };
    try {
      await api(`/api/applications/${currentId}`, patchOptions(body));
      toast("已保存");
      closeDrawer();
      await refresh();
    } catch (err) { toast("保存失败：" + err.message); }
  });
}

(async function init() {
  applyPeriod("today", false);
  bindUI();
  await loadMeta();
  await refresh();
  if (location.hash === "#settings") await openSettings();
})();
