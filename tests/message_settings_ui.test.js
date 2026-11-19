"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

async function fixture() {
  const elements = new Map();
  for (const id of ["#settings-form", "#resume", "#message", "#message-2", "#message-3", "#resume-status", "#status"]) {
    elements.set(id, { value: "", textContent: "", files: [], addEventListener(type, fn) { this[type] = fn; } });
  }
  const button = {};
  elements.get("#settings-form").querySelector = () => button;
  const patches = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../web/first-contact-settings.js"), "utf8"), {
    document: { querySelector: id => elements.get(id) },
    fetch: async (_url, options) => {
      if (options?.method === "PATCH") patches.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ advantage_message: "旧测试文字", resume: { exists: true, mime: "image/png", name: "fixture.png" } }) };
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  return { elements, patches, submit: () => elements.get("#settings-form").submit({ preventDefault() {} }) };
}
test("旧配置回填第一框，三个输入按顺序保存，空的可选框跳过", async () => {
  const f = await fixture();
  assert.equal(f.elements.get("#message").value, "旧测试文字");
  f.elements.get("#message-3").value = "第三框测试";
  await f.submit();
  assert.deepEqual(f.patches, [{ advantage_messages: ["旧测试文字", "第三框测试"] }]);
});
test("第一段空白时不提交也不覆盖配置", async () => {
  const f = await fixture(); f.elements.get("#message").value = " ";
  await f.submit(); assert.equal(f.patches.length, 0);
});
