"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const snapshot = require("../extension/job_snapshot_core.js");

function textNode(value) {
  return { nodeType: 3, nodeValue: value };
}

function element(tag, value = "", attrs = {}, children = null, style = {}) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    hidden: false,
    style,
    childNodes: children || [textNode(value)],
    parentElement: null,
    getAttribute(name) { return attrs[name] ?? null; },
    querySelector() { return null; },
  };
  for (const child of node.childNodes) {
    if (child?.nodeType === 1) child.parentElement = node;
  }
  Object.defineProperty(node, "textContent", {
    get() {
      return this.childNodes.map((child) => child.nodeType === 3 ? child.nodeValue : child.textContent).join("");
    },
  });
  return node;
}

function fixture({ salary = "10-14K", sidebar = true, salaryFont = "kanzhun-salary" } = {}) {
  const title = element("span", "AI产品经理");
  const jd = element("p", "负责AI产品规划", {}, [
    textNode("负责AI"),
    element("span", "来自BOSS直聘", {}, null, { visibility: "hidden" }),
    textNode("产品规划"),
  ]);
  const boss = element("div", "虚构公司甲 · 招聘经理");
  const hrName = element("h2", "测试HR甲 在线");
  const activity = element("span", "在线");
  const salaryNode = element("span", salary);
  const address = element("p", "深圳示例区测试路1号");
  const city = element("a", "深圳", { href: "/c101280600/" });
  const tags = [element("li", "深圳"), element("li", "3-5年"), element("li", "本科")];
  const company = sidebar ? element("a", "虚构公司甲") : null;
  const stageParent = element("p", "不需要融资");
  const scaleParent = element("p", "1000-9999人");
  const industryParent = element("p", "计算机软件");
  const stageIcon = element("i"); stageIcon.parentElement = stageParent;
  const scaleIcon = element("i"); scaleIcon.parentElement = scaleParent;
  const industryIcon = element("i"); industryIcon.parentElement = industryParent;
  const action = element("a", "立即沟通", { ka: "cpc_job_list_chat_job-123" });
  const detail = element("div");
  detail.querySelector = (selector) => selector.includes("[ka^='cpc_job_list_chat_']") ? action : null;

  const singles = [
    [".job-detail-container", detail],
    [".job-detail-info .job-name", title],
    [".job-detail-body .desc", jd],
    [".job-boss-info .boss-info-attr", boss],
    [".sider-company a[ka='job-detail-company_custompage']", company],
    [".job-detail-info .job-salary", salaryNode],
    [".job-boss-info h2.name", hrName],
    [".boss-active-time", activity],
    [".job-detail-header .tag-list a", city],
    [".job-address-desc", address],
    [".sider-company .icon-stage", sidebar ? stageIcon : null],
    [".sider-company .icon-scale", sidebar ? scaleIcon : null],
    [".sider-company .icon-industry", sidebar ? industryIcon : null],
    [".job-detail-op [ka^='cpc_job_list_chat_']", action],
  ];
  const doc = {
    querySelector(selector) {
      const found = singles.find(([needle, value]) => value && selector.includes(needle));
      return found ? found[1] : null;
    },
    querySelectorAll(selector) {
      if (selector.includes(".job-detail-header .tag-list li")) return tags;
      return [];
    },
  };
  const view = { getComputedStyle: (node) => ({
    display: node.style?.display || "block",
    visibility: node.style?.visibility || "visible",
    fontSize: node.style?.fontSize || "16px",
    opacity: node.style?.opacity || "1",
    fontFamily: node === salaryNode ? salaryFont : "Arial",
  }) };
  return { doc, view };
}

test("可读薪资保留原文并解析上下限和发薪月数", () => {
  assert.deepEqual(snapshot.parseSalary("10-14K"), {
    salary_raw: "10-14K", salary_min_k: 10, salary_max_k: 14,
    salary_months: null, salary_capture_status: "readable",
  });
  assert.deepEqual(snapshot.parseSalary("20-35K·16薪"), {
    salary_raw: "20-35K·16薪", salary_min_k: 20, salary_max_k: 35,
    salary_months: 16, salary_capture_status: "readable",
  });
});

test("字体混淆薪资不生成推测数字", () => {
  assert.deepEqual(snapshot.parseSalary("\uE032\uE030-\uE033\uE035K"), {
    salary_raw: "", salary_min_k: null, salary_max_k: null,
    salary_months: null, salary_capture_status: "font_obfuscated",
  });
});

test("确认的私用区映射解码薪资并保留解析结果", () => {
  assert.deepEqual(snapshot.parseSalary("\uE032\uE036-\uE034\uE031K·\uE032\uE035薪"), {
    salary_raw: "15-30K·14薪", salary_min_k: 15, salary_max_k: 30,
    salary_months: 14, salary_capture_status: "font_decoded",
    salary_decode_method: "pua_codepoint_minus_e031",
  });
});

test("字体混淆薪资保留DOM原文、码点和计算字体", () => {
  const { doc, view } = fixture({ salary: "\uE032\uE030-\uE033\uE035K", salaryFont: "boss-salary-font" });
  const result = snapshot.extract(doc, view, { pathname: "/web/geek/jobs" });
  assert.equal(result.job.salary_raw, "");
  assert.equal(result.job.salary_dom_raw, "\uE032\uE030-\uE033\uE035K");
  assert.deepEqual(result.job.salary_codepoints, [
    "U+E032", "U+E030", "U+002D", "U+E033", "U+E035", "U+004B",
  ]);
  assert.equal(result.job.salary_font_family, "boss-salary-font");
  assert.equal(result.job.salary_capture_status, "font_obfuscated");
});

test("完整页面提取岗位、公司、JD、地址和HR并过滤隐藏噪声", () => {
  const { doc, view } = fixture({ salary: "20-35K·16薪" });
  const result = snapshot.extract(doc, view, { pathname: "/web/geek/jobs", href: "https://www.zhipin.com/web/geek/jobs" });
  assert.equal(result.capture.status, "complete");
  assert.equal(result.job.job_key, "job-123");
  assert.equal(result.job.title, "AI产品经理");
  assert.equal(result.job.company_name, "虚构公司甲");
  assert.equal(result.job.company_size, "1000-9999人");
  assert.equal(result.job.industry, "计算机软件");
  assert.equal(result.job.financing_stage, "不需要融资");
  assert.equal(result.job.city, "深圳");
  assert.equal(result.job.address, "深圳示例区测试路1号");
  assert.equal(result.job.experience, "3-5年");
  assert.equal(result.job.education, "本科");
  assert.equal(result.job.jd_text, "负责AI产品规划");
  assert.equal(result.job.hr.name, "测试HR甲");
  assert.equal(result.job.hr.title, "招聘经理");
  assert.equal(result.job.hr.activity_text, "在线");
  assert.equal(result.action_label, "立即沟通");
});

test("新版页面缺少公司附加信息时仍可形成完整快照", () => {
  const { doc, view } = fixture({ sidebar: false, salary: "\uE031\uE030-\uE031\uE034K" });
  const result = snapshot.extract(doc, view, { pathname: "/web/geek/jobs" });
  assert.equal(result.capture.status, "complete");
  assert.equal(result.job.company_name, "虚构公司甲");
  assert.equal(result.job.company_size, "");
  assert.equal(result.job.salary_capture_status, "font_obfuscated");
  assert.equal(result.job.salary_dom_raw, "\uE031\uE030-\uE031\uE034K");
  assert.deepEqual(result.job.salary_codepoints, [
    "U+E031", "U+E030", "U+002D", "U+E031", "U+E034", "U+004B",
  ]);
  assert.equal(result.job.salary_font_family, "kanzhun-salary");
  assert.deepEqual(result.capture.warnings, ["salary_font_obfuscated"]);
});
