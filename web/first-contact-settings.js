"use strict";

const MAX_RESUMES = 9;
const form = document.querySelector("#settings-form");
const fileInput = document.querySelector("#resume");
const messageInput = document.querySelector("#message");
const messageInputs = [messageInput, document.querySelector("#message-2"), document.querySelector("#message-3")];
const resumeStatus = document.querySelector("#resume-status");
const status = document.querySelector("#status");
const clearPendingButton = document.querySelector("#clear-pending");
const clearSavedButton = document.querySelector("#clear-saved");
let existingResumes = [];
let pendingFiles = [];

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

function configuredResumes(settings) {
  if (Array.isArray(settings.resumes) && settings.resumes.length) return settings.resumes;
  return settings.resume?.exists ? [settings.resume] : [];
}

const fileKey = (file) => [file.name, file.size, file.lastModified].join("\u001f");
const isCompatible = (file) => ["image/jpeg", "image/png"].includes(file.type) &&
  file.size <= 8 * 1024 * 1024;

function renderResumeStatus() {
  if (clearPendingButton) clearPendingButton.disabled = pendingFiles.length === 0;
  if (clearSavedButton) {
    clearSavedButton.disabled = existingResumes.length === 0 && pendingFiles.length === 0;
  }
  const total = existingResumes.length + pendingFiles.length;
  if (!total) {
    resumeStatus.textContent = "尚未配置简历图片";
    return;
  }
  const items = [
    ...existingResumes.map((item, index) => {
      const missing = item.exists === false;
      const incompatible = !["image/jpeg", "image/png"].includes(item.mime);
      return `${index + 1}. ${item.name || "未命名"}${missing ? "（文件缺失）" : incompatible ? "（格式不支持）" : ""}`;
    }),
    ...pendingFiles.map((file, index) => `${existingResumes.length + index + 1}. ${file.name}（待添加）`),
  ];
  resumeStatus.textContent = `共 ${total} 张：${items.join("；")}`;
}

function addFiles(files) {
  let added = 0;
  for (const file of files) {
    if (!isCompatible(file)) {
      show(`${file.name} 不是 JPG/PNG 或超过 8 MB，已跳过`, true);
      continue;
    }
    if (existingResumes.length + pendingFiles.length >= MAX_RESUMES) {
      show(`最多保留 ${MAX_RESUMES} 张简历图片`, true);
      break;
    }
    if (pendingFiles.some(item => fileKey(item) === fileKey(file))) continue;
    pendingFiles.push(file);
    added += 1;
  }
  renderResumeStatus();
  return added;
}

async function load() {
  try {
    const settings = await request("/api/settings");
    const texts = settings.advantage_messages ?? [settings.advantage_message || ""];
    messageInputs.forEach((input, index) => { input.value = texts[index] || ""; });
    existingResumes = configuredResumes(settings);
    renderResumeStatus();
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

fileInput.addEventListener("change", () => {
  const selected = [...fileInput.files];
  fileInput.value = "";
  if (!selected.length) return;
  const added = addFiles(selected);
  if (added) show(`已加入 ${added} 张图片；可继续点“选择文件”添加下一张`, false);
});

clearPendingButton.addEventListener("click", () => {
  pendingFiles = [];
  fileInput.value = "";
  renderResumeStatus();
  show("已清空本次选择", false);
});

clearSavedButton.addEventListener("click", async () => {
  if (!existingResumes.length && !pendingFiles.length) return;
  if (typeof confirm === "function" && !confirm("确定清空已保存的全部简历图片吗？")) return;
  try {
    const result = await request("/api/settings/resumes/clear", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    existingResumes = Array.isArray(result.resumes) ? result.resumes : [];
    pendingFiles = [];
    fileInput.value = "";
    renderResumeStatus();
    show("已清空全部简历图片", false);
  } catch (error) {
    show(`清空失败：${error.message}`, true);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (fileInput.files.length) {
    addFiles([...fileInput.files]);
    fileInput.value = "";
  }
  const files = pendingFiles.slice();
  const messages = messageInputs.map(input => input.value.trim()).filter(Boolean);
  if (!messageInput.value.trim()) return show("请填写图片后的话术", true);
  const existingUsable = existingResumes.length > 0 && existingResumes.every(item =>
    item.exists !== false && ["image/jpeg", "image/png"].includes(item.mime));
  if (!existingUsable && !files.length) {
    return show(`请先选择 1–${MAX_RESUMES} 张 JPG/PNG 简历图片`, true);
  }
  if (existingResumes.length + files.length > MAX_RESUMES) {
    return show(`最多保留 ${MAX_RESUMES} 张简历图片`, true);
  }
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  show("正在保存…");
  try {
    await request("/api/settings", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ advantage_messages: messages }),
    });
    if (files.length) {
      const uploads = [];
      for (const file of files) {
        uploads.push({ filename: file.name, data_url: await fileDataUrl(file) });
      }
      const result = await request("/api/settings/resumes/append", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: uploads }),
      });
      if (Array.isArray(result.resumes)) existingResumes = result.resumes;
    }
    pendingFiles = [];
    fileInput.value = "";
    renderResumeStatus();
    show(`设置已保存，共 ${existingResumes.length} 张图片。现在可以回到 BOSS 消息页。`, false);
  } catch (error) {
    show(`保存失败：${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});

load();
