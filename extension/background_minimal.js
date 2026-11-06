"use strict";

// 本次降级只为消息页提供本地配置和简历图片，不再轮询或触发旧采集流程。
const SERVER = "http://127.0.0.1:8787";
const SNAPSHOT_QUEUE_KEY = "bt-contact-snapshot-queue";
const SNAPSHOT_RETRY_ALARM = "bt-contact-snapshot-retry";
let claimQueue = Promise.resolve();
let snapshotQueue = Promise.resolve();

async function readSnapshotQueue() {
  const stored = await chrome.storage.local.get(SNAPSHOT_QUEUE_KEY);
  return Array.isArray(stored[SNAPSHOT_QUEUE_KEY]) ? stored[SNAPSHOT_QUEUE_KEY] : [];
}

async function writeSnapshotQueue(items) {
  await chrome.storage.local.set({ [SNAPSHOT_QUEUE_KEY]: items });
  if (!chrome.alarms) return;
  if (items.length) chrome.alarms.create(SNAPSHOT_RETRY_ALARM, { delayInMinutes: 1 });
  else await chrome.alarms.clear(SNAPSHOT_RETRY_ALARM);
}

async function postSnapshot(payload) {
  const response = await fetch(`${SERVER}/api/contact-snapshots`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.retryable = response.status === 404 || response.status === 429 || response.status >= 500;
    throw error;
  }
  return data;
}

async function removeQueuedSnapshot(eventId) {
  const items = await readSnapshotQueue();
  const next = items.filter((item) => item.payload?.event_id !== eventId);
  if (next.length !== items.length) await writeSnapshotQueue(next);
}

async function enqueueSnapshot(payload, error) {
  const items = await readSnapshotQueue();
  const queued = {
    payload,
    queued_at: new Date().toISOString(),
    last_error: String(error?.message || error || "本地服务不可用"),
  };
  const index = items.findIndex((item) => item.payload?.event_id === payload.event_id);
  if (index >= 0) items[index] = queued;
  else items.push(queued);
  await writeSnapshotQueue(items);
}

async function flushSnapshotQueue() {
  const items = await readSnapshotQueue();
  const remaining = [];
  let saved = 0;
  for (const item of items) {
    try {
      await postSnapshot(item.payload);
      saved += 1;
    } catch (error) {
      if (error?.retryable !== false) {
        remaining.push({ ...item, last_error: String(error?.message || error) });
      }
    }
  }
  await writeSnapshotQueue(remaining);
  return { saved, remaining: remaining.length };
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === "tracker:claim") {
    const key = String(message.key || "");
    if (!/^bt-first-contact:[0-9A-Za-z_-]+$/.test(key)) {
      respond({ ok: false, error: "无效的会话尝试标识" });
      return;
    }
    const result = claimQueue.then(async () => {
      const existing = await chrome.storage.local.get(key);
      if (existing[key]) return { ok: true, claimed: false };
      await chrome.storage.local.set({ [key]: { stage: "started", at: Date.now() } });
      return { ok: true, claimed: true };
    });
    claimQueue = result.catch(() => {});
    result.then(respond).catch((error) => respond({ ok: false, error: String(error.message || error) }));
    return true;
  }
  if (message?.type === "tracker:contact-snapshot") {
    const payload = message.payload;
    if (!payload || !/^boss-contact:[0-9A-Za-z:_-]+$/.test(String(payload.event_id || ""))) {
      respond({ ok: false, error: "无效的岗位快照事件" });
      return;
    }
    const result = snapshotQueue.then(async () => {
      try {
        const data = await postSnapshot(payload);
        await removeQueuedSnapshot(payload.event_id);
        return { ok: true, queued: false, data };
      } catch (error) {
        if (error?.retryable === false) {
          return { ok: false, queued: false, error: String(error?.message || error) };
        }
        await enqueueSnapshot(payload, error);
        return { ok: true, queued: true, error: String(error?.message || error) };
      }
    });
    snapshotQueue = result.catch(() => {});
    result.then(respond).catch((error) => respond({ ok: false, error: String(error.message || error) }));
    return true;
  }
  if (message?.type !== "tracker:api") return;
  const path = String(message.path || "");
  if (!["/api/settings", "/api/resume"].includes(path) || message.method !== "GET") {
    respond({ ok: false, error: "不支持的本地接口" });
    return;
  }
  fetch(`${SERVER}${path}`)
    .then(async (response) => {
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.error || `HTTP ${response.status}`);
      }
      if (message.responseType === "binary") {
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return { ok: true, data: { data: btoa(binary), mime: response.headers.get("Content-Type") || "image/jpeg" } };
      }
      return { ok: true, data: await response.json() };
    })
    .then(respond)
    .catch((error) => respond({ ok: false, error: String(error.message || error) }));
  return true;
});

if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== SNAPSHOT_RETRY_ALARM) return;
    const result = snapshotQueue.then(flushSnapshotQueue);
    snapshotQueue = result.catch(() => {});
  });
}
