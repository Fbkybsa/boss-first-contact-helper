/* Extract a structured snapshot from the currently selected BOSS job detail. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BTJobSnapshot = api;
})(globalThis, function () {
  "use strict";

  const PRIVATE_USE = /[\uE000-\uF8FF]/;
  const SALARY_DIGIT_START = 0xE031;
  const SALARY_DIGIT_END = 0xE03A;
  const SALARY_DECODE_METHOD = "pua_codepoint_minus_e031";
  const EXPERIENCE = /^(经验不限|不限经验|在校\/应届|应届生?|\d+(?:-\d+)?年(?:以上|以内)?|1年以内)$/;
  const EDUCATION = /^(学历不限|不限学历|初中及以下|初中|中专\/中技|中专|高中|大专|本科|硕士|博士)$/;

  function clean(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function visibleText(node, view) {
    if (!node) return "";
    let out = "";
    const walk = (current) => {
      if (!current) return;
      if (current.nodeType === 3) {
        out += current.nodeValue || "";
        return;
      }
      if (current.nodeType !== 1) return;
      const tag = String(current.tagName || "").toUpperCase();
      if (["STYLE", "SCRIPT", "NOSCRIPT"].includes(tag)) return;
      if (current.hidden || current.getAttribute?.("aria-hidden") === "true") return;
      const style = view?.getComputedStyle ? view.getComputedStyle(current) : null;
      if (style && (style.display === "none" || style.visibility === "hidden" ||
          style.fontSize === "0px" || style.opacity === "0")) return;
      for (const child of current.childNodes || []) walk(child);
    };
    walk(node);
    return clean(out);
  }

  function text(doc, view, selector) {
    return visibleText(doc.querySelector(selector), view);
  }

  function texts(doc, view, selector) {
    return [...doc.querySelectorAll(selector)].map((node) => visibleText(node, view)).filter(Boolean);
  }

  function firstParentText(doc, view, selector) {
    const icon = doc.querySelector(selector);
    return visibleText(icon?.parentElement, view);
  }

  function beforeDot(value) {
    return clean(value).split(/[·•]/)[0]?.trim() || "";
  }

  function afterDot(value) {
    const parts = clean(value).split(/[·•]/);
    return parts.length > 1 ? parts.slice(1).join("·").trim() : "";
  }

  function parseSalary(value) {
    const raw = clean(value);
    if (!raw) {
      return { salary_raw: "", salary_min_k: null, salary_max_k: null,
        salary_months: null, salary_capture_status: "missing" };
    }
    if (PRIVATE_USE.test(raw)) {
      let decoded = "";
      let supported = true;
      for (const character of Array.from(raw)) {
        const codepoint = character.codePointAt(0);
        if (codepoint >= 0xE000 && codepoint <= 0xF8FF) {
          if (codepoint < SALARY_DIGIT_START || codepoint > SALARY_DIGIT_END) {
            supported = false;
            break;
          }
          decoded += String(codepoint - SALARY_DIGIT_START);
        } else {
          decoded += character;
        }
      }
      if (supported) {
        const result = parseSalary(decoded);
        return {
          ...result,
          salary_capture_status: "font_decoded",
          salary_decode_method: SALARY_DECODE_METHOD,
        };
      }
      return { salary_raw: "", salary_min_k: null, salary_max_k: null,
        salary_months: null, salary_capture_status: "font_obfuscated" };
    }
    const result = { salary_raw: raw, salary_min_k: null, salary_max_k: null,
      salary_months: null, salary_capture_status: "readable" };
    const match = raw.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(K|k|万|W)(?:\s*[·x×*]\s*(\d+)\s*薪)?/);
    if (!match) return result;
    const factor = /^(万|W)$/.test(match[3]) ? 10 : 1;
    result.salary_min_k = Number(match[1]) * factor;
    result.salary_max_k = Number(match[2]) * factor;
    result.salary_months = match[4] ? Number(match[4]) : null;
    return result;
  }

  function salaryEvidence(node, view) {
    const domRaw = visibleText(node, view);
    let fontFamily = "";
    try {
      fontFamily = clean(node && view?.getComputedStyle ? view.getComputedStyle(node)?.fontFamily : "");
    } catch (_error) {
      fontFamily = "";
    }
    return {
      salary_dom_raw: domRaw,
      salary_codepoints: Array.from(domRaw).map((character) =>
        `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`),
      salary_font_family: fontFamily,
    };
  }

  function jobKey(doc, locationLike) {
    const pathMatch = String(locationLike?.pathname || "").match(/\/job_detail\/([^.?/]+)\.html/);
    if (pathMatch) return pathMatch[1];

    const detail = doc.querySelector(".job-detail-container .job-detail-box, .job-detail-box, .job-primary") || doc;
    const action = detail.querySelector?.(
      "[ka^='cpc_job_list_chat_'], [ka^='popjob_interest_tosign_'], [ka^='job_detail_chat_']"
    );
    const ka = String(action?.getAttribute?.("ka") || "");
    const kaMatch = ka.match(/^(?:cpc_job_list_chat|popjob_interest_tosign|job_detail_chat)_(.+)$/);
    if (kaMatch) return kaMatch[1];

    const dataUrl = String(action?.getAttribute?.("data-url") || action?.getAttribute?.("redirect-url") || "");
    const dataMatch = dataUrl.match(/(?:job_detail\/|jobId=)([^.&?/~]+)/);
    if (dataMatch) return dataMatch[1];

    const link = detail.querySelector?.("a[href*='/job_detail/']");
    const hrefMatch = String(link?.getAttribute?.("href") || "").match(/\/job_detail\/([^.?]+)\.html/);
    return hrefMatch ? hrefMatch[1] : "";
  }

  function jdNode(doc) {
    const direct = doc.querySelector(".job-detail-body .desc, .job-detail-section .job-sec-text");
    if (direct) return direct;
    for (const section of doc.querySelectorAll(".job-detail-section")) {
      if (/职位描述|岗位描述/.test(clean(section.querySelector("h3")?.textContent))) {
        return section.querySelector(".job-sec-text");
      }
    }
    return null;
  }

  function unique(values) {
    return [...new Set(values.map(clean).filter(Boolean))];
  }

  function headerFacts(doc, view) {
    const values = [];
    for (const value of texts(doc, view, ".job-detail-header .tag-list li, .job-primary .info-primary p")) {
      values.push(...value.split(/\s+/).filter(Boolean));
    }
    const explicitCity = text(doc, view,
      ".job-detail-header .tag-list a[href^='/c'], .job-primary .text-city, .job-detail-info .text-city");
    const experience = values.find((value) => EXPERIENCE.test(value)) || "";
    const education = values.find((value) => EDUCATION.test(value)) || "";
    const city = explicitCity || values.find((value) => value !== experience && value !== education) || "";
    const extra = texts(doc, view, ".job-keyword-list li, .job-tags li, .job-detail-body .job-tags li");
    return {
      city,
      experience,
      education,
      job_tags: unique([...values.filter((value) => ![city, experience, education].includes(value)), ...extra]),
    };
  }

  function canonicalUrl(key, locationLike) {
    if (key) return `https://www.zhipin.com/job_detail/${key}.html`;
    const raw = String(locationLike?.href || "");
    return raw.split(/[?#]/)[0];
  }

  function extract(doc, view, locationLike) {
    const key = jobKey(doc, locationLike);
    const title = text(doc, view,
      ".job-detail-info .job-name, .job-primary .name h1, .job-detail-box .job-name, .position-content .name");
    const jd = jdNode(doc);
    const bossAttr = text(doc, view, ".job-boss-info .boss-info-attr, .job-detail-info .boss-title");
    const companyName = text(doc, view,
      ".sider-company a[ka='job-detail-company_custompage'], .job-detail-company .company-name, .job-detail-info .company-name") ||
      beforeDot(bossAttr);
    const facts = headerFacts(doc, view);
    const salaryNode = doc.querySelector(
      ".job-detail-info .job-salary, .job-primary .name .salary"
    );
    const salaryEvidenceFields = salaryEvidence(salaryNode, view);
    const salary = {
      ...parseSalary(salaryEvidenceFields.salary_dom_raw),
      ...salaryEvidenceFields,
    };
    const hrName = text(doc, view, ".job-boss-info h2.name, .job-detail-info .boss-name").split(/\s+/)[0] || "";
    const actionLabel = text(doc, view,
      ".job-detail-op [ka^='cpc_job_list_chat_'], .job-detail-op [ka^='popjob_interest_tosign_'], .job-primary .btn-startchat");
    const missing = [];
    if (!key) missing.push("job_key");
    if (!title) missing.push("title");
    const jdText = visibleText(jd, view);
    if (!jdText) missing.push("jd_text");

    return {
      job: {
        job_key: key,
        title,
        company_name: companyName,
        company_size: firstParentText(doc, view, ".sider-company .icon-scale"),
        industry: firstParentText(doc, view, ".sider-company .icon-industry"),
        financing_stage: firstParentText(doc, view, ".sider-company .icon-stage"),
        city: facts.city,
        address: text(doc, view, ".job-address-desc, .location-address"),
        experience: facts.experience,
        education: facts.education,
        job_tags: facts.job_tags,
        ...salary,
        url: canonicalUrl(key, locationLike),
        jd_text: jdText,
        hr: {
          name: hrName,
          title: afterDot(bossAttr),
          activity_text: text(doc, view,
            ".job-boss-info .boss-active-time, .job-boss-info .boss-online-tag, " +
            ".job-detail-info .boss-active-time, .job-detail-info .boss-online-tag"),
        },
      },
      action_label: /^(立即沟通|立即投递)$/.test(actionLabel) ? actionLabel : "",
      capture: {
        status: missing.length ? "failed" : "complete",
        missing_fields: missing,
        warnings: salary.salary_capture_status === "font_obfuscated" ? ["salary_font_obfuscated"] :
          salary.salary_capture_status === "font_decoded" ? ["salary_font_decoded"] : [],
      },
    };
  }

  return { clean, visibleText, parseSalary, salaryEvidence, jobKey, extract };
});
