const TOKEN_KEY = "advanced_chat_jwt";
const API_BASE_KEY = "cloudStorage.apiBase";
const DEFAULT_API_BASE = "https://apigateway1-khy4.onrender.com/cloudstorage";

const elements = {
  sessionPill: document.getElementById("sessionPill"),
  serviceStatus: document.getElementById("serviceStatus"),
  apiBaseInput: document.getElementById("apiBaseInput"),
  saveApiButton: document.getElementById("saveApiButton"),
  refreshQuotaButton: document.getElementById("refreshQuotaButton"),
  refreshFilesButton: document.getElementById("refreshFilesButton"),
  uploadButton: document.getElementById("uploadButton"),
  fileInput: document.getElementById("fileInput"),
  uploadHint: document.getElementById("uploadHint"),
  quotaBar: document.getElementById("quotaBar"),
  quotaTotal: document.getElementById("quotaTotal"),
  quotaUsed: document.getElementById("quotaUsed"),
  quotaDrive: document.getElementById("quotaDrive"),
  filesBody: document.getElementById("filesBody"),
  output: document.getElementById("output"),
  toast: document.getElementById("toast"),
};

let token = readTokenFromUrl() || localStorage.getItem(TOKEN_KEY) || "";

if (token && isTokenActive(token)) {
  localStorage.setItem(TOKEN_KEY, token);
  removeTokenFromUrl();
} else {
  redirectHome(token ? "expired" : "");
}

window.addEventListener("storage", (event) => {
  if (event.key === TOKEN_KEY && !isTokenActive(event.newValue || "")) {
    redirectHome("expired");
  }
});

function readTokenFromUrl() {
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return query.get("token") || hash.get("token") || "";
}

function removeTokenFromUrl() {
  window.history.replaceState({}, document.title, window.location.pathname || "/");
}

function redirectHome(reason = "") {
  localStorage.removeItem(TOKEN_KEY);
  const suffix = reason ? `&reason=${encodeURIComponent(reason)}` : "";
  window.location.replace(`../index.html?authRequired=cloudstorage${suffix}`);
}

function decodeJwtPayload(jwt) {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - base64.length % 4) % 4), "=");
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function isTokenActive(jwt) {
  const payload = decodeJwtPayload(jwt);
  if (!payload) return false;
  return !payload.exp || payload.exp * 1000 > Date.now();
}

function getApiBase() {
  return elements.apiBaseInput.value.trim().replace(/\/+$/, "");
}

function authHeaders() {
  return { Authorization: `Bearer ${token}` };
}

async function apiFetch(path, options = {}) {
  const response = await fetch(`${getApiBase()}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      redirectHome("expired");
      return response;
    }
    const message = await readError(response);
    throw new Error(message || `Request failed with ${response.status}`);
  }

  return response;
}

async function readError(response) {
  const text = await response.text();
  if (!text) return "";

  try {
    const body = JSON.parse(text);
    return body.error || text;
  } catch {
    return text;
  }
}

function renderSession() {
  const enabled = Boolean(token);
  elements.refreshQuotaButton.disabled = !enabled;
  elements.refreshFilesButton.disabled = !enabled;
  elements.uploadButton.disabled = !enabled;
  elements.fileInput.disabled = !enabled;

  if (!enabled) {
    elements.sessionPill.className = "session-pill disconnected";
    elements.sessionPill.innerHTML = '<span class="dot"></span>Not signed in';
    return;
  }

  elements.sessionPill.className = "session-pill connected";
  elements.sessionPill.innerHTML = '<span class="dot"></span>Logged in · Session active';
}

function goHome() {
  window.location.href = "../index.html";
}

async function checkService() {
  try {
    await apiFetch("/");
    setStatus("Online", "connected");
  } catch {
    setStatus("Offline", "");
  }
}

function setStatus(text, state) {
  elements.serviceStatus.className = state ? `badge ${state}` : "badge";
  elements.serviceStatus.innerHTML = `<span class="dot"></span>${escapeHtml(text)}`;
}

async function loadQuota() {
  if (!token) return;

  try {
    const response = await apiFetch("/storage", { headers: authHeaders() });
    const quota = await response.json();
    const limit = Number(quota.userLimit || quota.limit || 0);
    const usage = Number(quota.userUsage || quota.usage || 0);
    const remaining = Number(quota.userRemaining || Math.max(limit - usage, 0));
    const percent = limit > 0 ? Math.min((usage / limit) * 100, 100) : 0;

    elements.quotaBar.style.width = `${percent}%`;
    elements.quotaTotal.textContent = formatBytes(limit);
    elements.quotaUsed.textContent = formatBytes(usage);
    elements.quotaDrive.textContent = formatBytes(remaining);
  } catch (error) {
    setOutput(`ERROR:\n${error.message}`);
    showToast(error.message);
  }
}

async function loadFiles() {
  if (!token) return;

  setFilesMessage("Loading files...");
  try {
    const response = await apiFetch("/files", { headers: authHeaders() });
    const data = await response.json();
    renderFiles(data.files || []);
    setOutput("Files loaded.");
  } catch (error) {
    setFilesMessage(error.message);
    setOutput(`ERROR:\n${error.message}`);
    showToast(error.message);
  }
}

async function uploadFile() {
  const file = elements.fileInput.files[0];
  if (!file) {
    showToast("Choose a file first.");
    return;
  }
  if (file.size > 25 * 1024 * 1024) {
    showToast("Maximum upload size is 25 MB.");
    return;
  }

  const form = new FormData();
  form.append("file", file);

  elements.uploadButton.disabled = true;
  elements.uploadHint.textContent = "Uploading...";

  try {
    await apiFetch("/files", {
      method: "POST",
      headers: authHeaders(),
      body: form,
    });
    elements.fileInput.value = "";
    elements.uploadHint.textContent = "Upload complete.";
    setOutput(`Uploaded: ${file.name}`);
    showToast("File uploaded.");
    await Promise.all([loadQuota(), loadFiles()]);
  } catch (error) {
    elements.uploadHint.textContent = error.message;
    setOutput(`ERROR:\n${error.message}`);
    showToast(error.message);
  } finally {
    elements.uploadButton.disabled = false;
  }
}

async function downloadFile(file) {
  try {
    const response = await apiFetch(`/files/${encodeURIComponent(file.id)}`, {
      headers: authHeaders(),
    });
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name || "download";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    setOutput(`ERROR:\n${error.message}`);
    showToast(error.message);
  }
}

async function deleteFile(file) {
  const confirmed = window.confirm(`Delete "${file.name}"?`);
  if (!confirmed) return;

  try {
    await apiFetch(`/files/${encodeURIComponent(file.id)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    setOutput(`Deleted: ${file.name}`);
    showToast("File deleted.");
    await Promise.all([loadQuota(), loadFiles()]);
  } catch (error) {
    setOutput(`ERROR:\n${error.message}`);
    showToast(error.message);
  }
}

function renderFiles(files) {
  elements.filesBody.innerHTML = "";
  if (files.length === 0) {
    setFilesMessage("No files uploaded yet.");
    return;
  }

  for (const file of files) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><div class="file-name"></div></td>
      <td></td>
      <td></td>
      <td></td>
      <td><div class="file-actions"></div></td>
    `;

    row.children[0].querySelector(".file-name").textContent = file.name || "-";
    row.children[1].textContent = file.mimeType || "-";
    row.children[2].textContent = formatBytes(Number(file.size || 0));
    row.children[3].textContent = formatDate(file.modifiedTime);

    const actions = row.children[4].querySelector(".file-actions");
    const downloadButton = document.createElement("button");
    downloadButton.type = "button";
    downloadButton.className = "secondary compact";
    downloadButton.textContent = "Download";
    downloadButton.addEventListener("click", () => downloadFile(file));

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "danger compact";
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", () => deleteFile(file));

    actions.append(downloadButton, deleteButton);
    elements.filesBody.appendChild(row);
  }
}

function setFilesMessage(message) {
  elements.filesBody.innerHTML = `<tr><td colspan="5" class="empty"></td></tr>`;
  elements.filesBody.querySelector("td").textContent = message;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(value) {
  if (!value) return "-";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

let toastTimer;
function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 4200);
}

function saveApiBase() {
  localStorage.setItem(API_BASE_KEY, getApiBase());
  showToast("API URL saved.");
  checkService();
  Promise.all([loadQuota(), loadFiles()]);
}

function setOutput(message) {
  elements.output.textContent = message;
}

function clearOutput() {
  setOutput("Ready.");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function init() {
  elements.apiBaseInput.value = localStorage.getItem(API_BASE_KEY) || DEFAULT_API_BASE;
  elements.saveApiButton.addEventListener("click", saveApiBase);
  elements.refreshQuotaButton.addEventListener("click", loadQuota);
  elements.refreshFilesButton.addEventListener("click", loadFiles);
  elements.uploadButton.addEventListener("click", uploadFile);

  renderSession();
  checkService();
  Promise.all([loadQuota(), loadFiles()]);
}

init();
