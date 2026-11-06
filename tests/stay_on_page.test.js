"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { clean, isStayDialog } = require("../extension/stay_on_page_core.js");

test("发出招呼后的弹窗可匹配不同留页文案", () => {
  for (const stay of ["留在此页", "留在当前页", "留在本页", "留在当前页面", "继续留在当前页"]) {
    assert.equal(isStayDialog({ title: "已向 BOSS 发送消息", stay, continueText: "继续沟通" }), true);
  }
  assert.equal(clean(" 已向 BOSS 发送消息 "), "已向BOSS发送消息");
});

test("缺少发送成功标题或继续沟通选项时不点击", () => {
  const base = { title: "已向BOSS发送消息", stay: "留在此页", continueText: "继续沟通" };
  assert.equal(isStayDialog({ ...base, title: "确认离开页面" }), false);
  assert.equal(isStayDialog({ ...base, continueText: "确认提交" }), false);
  assert.equal(isStayDialog({ ...base, stay: "留在岗位详情" }), false);
});
