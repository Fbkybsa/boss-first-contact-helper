"use strict";

const form = document.querySelector("#settings-form");
const fileInput = document.querySelector("#resume");
const messageInput = document.querySelector("#message");
const resumeStatus = document.querySelector("#resume-status");
const status = document.querySelector("#status");
let existingResume = false;

async function request(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function show(message, error = false) {
  status.textContent = message;
  status.className = error ? "error" : "ok";
}

async function load() {
  try {
    const settings = await request("/api/settings");
    messageInput.value = settings.advantage_message || "";
    const compatible = ["image/jpeg", "image/png"].includes(settings.resume?.mime);
    existingResume = !!settings.resume?.exists && compatible;
    resumeStatus.textContent = existingResume
      ? `已配置：${settings.resume.name}（重新选择文件会替换）`
      : settings.resume?.exists ? "现有图片格式不受平台图片控件支持，请重新选择 JPG/PNG" : "尚未配置简历图片";
  } catch (error) {
    show(`读取设置失败：${error.message}`, true);
  }
}

function fileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  const message = messageInput.value.trim();
  if (!message) return show("请填写图片后的话术", true);
  if (!existingResume && !file) return show("请先选择简历图片", true);
  if (file && (!["image/jpeg", "image/png"].includes(file.type) || file.size > 8 * 1024 * 1024)) {
    return show("简历图片必须是 JPG/PNG 且不超过 8 MB", true);
  }
  const button = form.querySelector("button");
  button.disabled = true;
  show("正在保存…");
  try {
    await request("/api/settings", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ advantage_message: message }),
    });
    if (file) {
      await request("/api/settings/resume", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, data_url: await fileDataUrl(file) }),
      });
    }
    fileInput.value = "";
    await load();
    show("设置已保存。现在可以回到 BOSS 消息页。", false);
  } catch (error) {
    show(`保存失败：${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});

load();
