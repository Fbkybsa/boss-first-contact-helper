/* Pure matching rules for the post-greeting BOSS dialog. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BTStayOnPage = api;
})(globalThis, function () {
  "use strict";

  const clean = (value) => String(value || "").replace(/\s+/g, "").trim();
  const stayLabels = new Set([
    "留在当前页", "留在本页", "留在当前页面", "继续留在当前页", "留在此页",
  ]);

  function isStayDialog({ title, stay, continueText }) {
    return clean(title) === "已向BOSS发送消息" &&
      stayLabels.has(clean(stay)) && clean(continueText) === "继续沟通";
  }

  return { clean, stayLabels, isStayDialog };
});
