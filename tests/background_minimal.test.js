"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

test("并发点击同一会话只允许一次发送尝试", async () => {
  let listener;
  const saved = new Map();
  const chrome = {
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
    storage: { local: {
      async get(key) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return { [key]: saved.get(key) };
      },
      async set(items) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        for (const [key, value] of Object.entries(items)) saved.set(key, value);
      },
    } },
  };
  const source = fs.readFileSync(path.join(__dirname, "../extension/background_minimal.js"), "utf8");
  vm.runInNewContext(source, { chrome, Promise, Date, setTimeout });
  const invoke = () => new Promise((resolve) => {
    listener({ type: "tracker:claim", key: "bt-first-contact:12345" }, {}, resolve);
  });
  const results = await Promise.all([invoke(), invoke()]);
  assert.deepEqual(results.map((item) => item.claimed).sort(), [false, true]);
  assert.equal(saved.get("bt-first-contact:12345").stage, "started");
});

test("岗位快照服务失败时入队并由闹钟幂等重试", async () => {
  let listener;
  let alarmListener;
  let unavailable = true;
  const saved = new Map();
  const chrome = {
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
    storage: { local: {
      async get(key) { return { [key]: saved.get(key) }; },
      async set(items) { for (const [key, value] of Object.entries(items)) saved.set(key, value); },
    } },
    alarms: {
      create() {}, async clear() { return true; },
      onAlarm: { addListener(fn) { alarmListener = fn; } },
    },
  };
  const fetch = async () => {
    if (unavailable) throw new Error("service down");
    return { ok: true, async json() { return { ok: true }; } };
  };
  const source = fs.readFileSync(path.join(__dirname, "../extension/background_minimal.js"), "utf8");
  vm.runInNewContext(source, { chrome, fetch, Promise, Date, setTimeout, JSON, Uint8Array });
  const payload = { event_id: "boss-contact:test-1" };
  const queued = await new Promise((resolve) => {
    listener({ type: "tracker:contact-snapshot", payload }, {}, resolve);
  });
  assert.equal(queued.ok, true);
  assert.equal(queued.queued, true);
  assert.equal(saved.get("bt-contact-snapshot-queue").length, 1);

  unavailable = false;
  alarmListener({ name: "bt-contact-snapshot-retry" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(saved.get("bt-contact-snapshot-queue").length, 0);
});

test("岗位快照校验错误直接返回且不进入重试队列", async () => {
  let listener;
  const saved = new Map();
  const chrome = {
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
    storage: { local: {
      async get(key) { return { [key]: saved.get(key) }; },
      async set(items) { for (const [key, value] of Object.entries(items)) saved.set(key, value); },
    } },
  };
  const fetch = async () => ({
    ok: false, status: 400, async json() { return { error: "缺少平台沟通成功证据" }; },
  });
  const source = fs.readFileSync(path.join(__dirname, "../extension/background_minimal.js"), "utf8");
  vm.runInNewContext(source, { chrome, fetch, Promise, Date, setTimeout, JSON, Uint8Array });
  const result = await new Promise((resolve) => {
    listener({ type: "tracker:contact-snapshot", payload: { event_id: "boss-contact:bad" } }, {}, resolve);
  });
  assert.equal(result.ok, false);
  assert.equal(result.queued, false);
  assert.equal(saved.get("bt-contact-snapshot-queue"), undefined);
});
