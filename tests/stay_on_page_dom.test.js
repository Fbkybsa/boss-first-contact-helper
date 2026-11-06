"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const rules = require("../extension/stay_on_page_core.js");

const source = fs.readFileSync(path.join(__dirname, "../extension/stay_on_page.js"), "utf8");

function element(tag, ownText = "", children = []) {
  const node = {
    tag, ownText, children, parentElement: null, isConnected: true, inert: false,
    clicks: 0,
    get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(""); },
    querySelectorAll(selector) {
      const tags = selector.split(",").map((item) => item.trim().toLowerCase());
      const found = [];
      const visit = (child) => {
        if (tags.includes(child.tag)) found.push(child);
        child.children.forEach(visit);
      };
      this.children.forEach(visit);
      return found;
    },
    getBoundingClientRect() { return { width: 200, height: 40 }; },
    getAttribute() { return null; },
    click() { this.clicks += 1; },
  };
  children.forEach((child) => { child.parentElement = node; });
  return node;
}

function runFixture(title = "已向BOSS发送消息", options = {}) {
  const order = [];
  const sent = [];
  const stayText = options.nestedStay ? element("span", "留在此页") : null;
  const stay = options.nestedStay ? element("button", "", [stayText]) :
    element(options.stayTag || "button", "留在此页");
  stay.click = function () { this.clicks += 1; order.push("click"); };
  const proceed = element("button", "继续沟通");
  const dialog = element("div", "", [
    element("h2", title), element("p", "您好"), element("div", "", [stay, proceed]),
  ]);
  const body = element("body", "", [dialog]);
  const document = { body, querySelectorAll: (selector) => body.querySelectorAll(selector) };
  let observerCallback;
  class MutationObserver {
    constructor(callback) { observerCallback = callback; }
    observe() {}
  }
  const location = { pathname: "/web/geek/jobs" };
  const context = {
    BTStayOnPage: rules,
    BTJobSnapshot: { extract() {
      order.push("extract");
      options.onExtract?.(location, { body, dialog, stay, proceed });
      return {
        job: { job_key: "job-1", title: "AI产品经理", jd_text: "JD", hr: { activity_text: "在线" } },
        action_label: "立即沟通",
        capture: { status: "complete", missing_fields: [], warnings: [] },
      };
    } },
    chrome: { runtime: { async sendMessage(message) {
      order.push("submit"); sent.push(message); return { ok: true };
    } } },
    document, location,
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    MutationObserver, setTimeout, clearTimeout, Date, Math,
  };
  vm.runInNewContext(source, context);
  return { body, dialog, stay, stayText, proceed, observerCallback, order, sent, location };
}

test("发送成功弹窗只点击留在此页且同一弹窗不重按", async () => {
  const page = runFixture();
  assert.equal(page.stay.clicks, 1);
  assert.equal(page.proceed.clicks, 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(page.order, ["extract", "click", "submit"]);
  assert.equal(page.sent.length, 1);
  assert.equal(page.sent[0].type, "tracker:contact-snapshot");
  assert.equal(page.sent[0].payload.job.title, "AI产品经理");
  assert.equal(page.sent[0].payload.action.stay_button_clicked, true);
  page.observerCallback();
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(page.stay.clicks, 1);
});

test("其他弹窗即使有同名按钮也不点击", () => {
  const page = runFixture("确认离开页面");
  assert.equal(page.stay.clicks, 0);
  assert.equal(page.proceed.clicks, 0);
});

test("前一个弹窗关闭后可处理下一次发送成功弹窗", async () => {
  const page = runFixture();
  page.dialog.isConnected = false;
  page.body.children = [];
  page.observerCallback();
  await new Promise((resolve) => setTimeout(resolve, 130));

  const nextStay = element("button", "留在当前页");
  const nextDialog = element("div", "", [
    element("h2", "已向BOSS发送消息"), nextStay, element("button", "继续沟通"),
  ]);
  nextDialog.parentElement = page.body;
  page.body.children = [nextDialog];
  page.observerCallback();
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(nextStay.clicks, 1);
  assert.equal(page.sent.length, 2);
});

test("留页文案位于按钮内部时点击实际按钮而非文字节点", async () => {
  const page = runFixture("已向BOSS发送消息", { nestedStay: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(page.stay.clicks, 1);
  assert.equal(page.stayText.clicks, 0);
  assert.equal(page.proceed.clicks, 0);
  assert.equal(page.sent.length, 1);
});

test("无语义属性的div留页按钮仍可通过精确文案点击", async () => {
  const page = runFixture("已向BOSS发送消息", { stayTag: "div" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(page.stay.clicks, 1);
  assert.equal(page.proceed.clicks, 0);
  assert.equal(page.sent.length, 1);
});

test("提取快照期间路由变化但完整弹窗仍在时继续点击留页", async () => {
  const page = runFixture("已向BOSS发送消息", {
    onExtract(location) { location.pathname = "/web/geek/chat"; },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(page.order, ["extract", "click", "submit"]);
  assert.equal(page.stay.clicks, 1);
  assert.equal(page.proceed.clicks, 0);
  assert.equal(page.sent.length, 1);
});

test("提取期间弹窗被移除时不点击且后续可重试", async () => {
  let detached = true;
  const page = runFixture("已向BOSS发送消息", {
    onExtract(_location, fixture) {
      if (detached) fixture.dialog.isConnected = false;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(page.stay.clicks, 0);
  assert.equal(page.sent.length, 0);

  detached = false;
  page.dialog.isConnected = true;
  page.observerCallback();
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(page.stay.clicks, 1);
  assert.equal(page.sent.length, 1);
});

test("站内跳转到消息页后不会点击不完整的同名元素", async () => {
  const page = runFixture("确认离开页面");
  const stay = element("button", "留在此页");
  const dialog = element("div", "", [
    element("h2", "新消息"), stay, element("button", "继续沟通"),
  ]);
  dialog.parentElement = page.body;
  page.body.children = [dialog];
  page.location.pathname = "/web/geek/chat";
  page.observerCallback();
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(stay.clicks, 0);
  assert.equal(page.sent.length, 0);
});
