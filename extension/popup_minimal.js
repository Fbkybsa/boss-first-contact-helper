"use strict";

document.querySelector("#dashboard").addEventListener("click", () => {
  chrome.tabs.create({ url: "http://127.0.0.1:8787/first-contact-settings.html" });
});
