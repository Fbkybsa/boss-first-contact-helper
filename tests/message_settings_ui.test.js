"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const DEFAULT_SETTINGS = {
  advantage_message: "旧测试文字",
  resume: { exists: true, mime: "image/png", name: "fixture.png" },
};

async function fixture(settings = DEFAULT_SETTINGS) {
  const elements = new Map();
  for (const id of ["#settings-form", "#resume", "#message", "#message-2", "#message-3", "#resume-status", "#status", "#clear-pending", "#clear-saved"]) {
    elements.set(id, { value: "", textContent: "", files: [], addEventListener(type, fn) { this[type] = fn; } });
  }
  const button = {};
  elements.get("#settings-form").querySelector = () => button;
  const patches = [];
  const posts = [];
  class FileReader {
    readAsDataURL(file) {
      this.result = `data:${file.type};base64,AAAA`;
      this.onload();
    }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../web/first-contact-settings.js"), "utf8"), {
    document: { querySelector: id => elements.get(id) },
    FileReader,
    fetch: async (url, options) => {
      if (options?.method === "PATCH") patches.push(JSON.parse(options.body));
      if (options?.method === "POST") posts.push({ url, body: JSON.parse(options.body) });
      if (url === "/api/settings/resumes/clear") {
        return { ok: true, json: async () => ({ resumes: [] }) };
      }
      return { ok: true, json: async () => settings };
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  return { elements, patches, posts, submit: () => elements.get("#settings-form").submit({ preventDefault() {} }) };
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

test("多选图片按选择顺序追加到多图接口并显示现有张数", async () => {
  const f = await fixture({
    advantage_message: "测试文字",
    resumes: [
      { exists: true, mime: "image/png", name: "第一张.png" },
      { exists: true, mime: "image/jpeg", name: "第二张.jpg" },
    ],
  });
  assert.match(f.elements.get("#resume-status").textContent, /共 2 张/);
  f.elements.get("#message").value = "测试文字";
  f.elements.get("#resume").files = [
    { name: "甲.png", type: "image/png", size: 10 },
    { name: "乙.jpg", type: "image/jpeg", size: 20 },
  ];
  await f.submit();
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].url, "/api/settings/resumes/append");
  assert.deepEqual(f.posts[0].body.files.map(item => item.filename), ["甲.png", "乙.jpg"]);
});

test("分两次选择文件会追加为第二张而不是顶掉第一张", async () => {
  const f = await fixture({ advantage_message: "测试文字", resumes: [] });
  f.elements.get("#message").value = "测试文字";
  const input = f.elements.get("#resume");
  input.files = [{ name: "第一张.png", type: "image/png", size: 10, lastModified: 1 }];
  input.change();
  input.files = [{ name: "第二张.png", type: "image/png", size: 10, lastModified: 2 }];
  input.change();
  assert.match(f.elements.get("#resume-status").textContent,
    /1\. 第一张\.png（待添加）[\s\S]*2\. 第二张\.png（待添加）/);
  await f.submit();
  assert.deepEqual(f.posts[0].body.files.map(item => item.filename), ["第一张.png", "第二张.png"]);
});

test("删除全部已保存图片后列表立即清空", async () => {
  const f = await fixture({
    advantage_message: "测试文字",
    resumes: [
      { exists: true, mime: "image/png", name: "第一张.png" },
      { exists: true, mime: "image/jpeg", name: "第二张.jpg" },
    ],
  });
  await f.elements.get("#clear-saved").click();
  assert.equal(f.elements.get("#resume-status").textContent, "尚未配置简历图片");
  assert.equal(f.posts[0].url, "/api/settings/resumes/clear");
});
