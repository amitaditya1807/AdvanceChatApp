const TOKEN_KEY = "advanced_chat_jwt";
const API_BASE_KEY = "cloudStorage.apiBase";
const DEFAULT_API_BASE = "https://apigateway1-khy4.onrender.com/cloudstorage";
const USER_STORAGE_LIMIT_BYTES = 100 * 1024 * 1024;
const PREMIUM_STORAGE_LIMIT_BYTES = 200 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

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
  dropZone: document.getElementById("dropZone"),
  selectedFileName: document.getElementById("selectedFileName"),
  selectedFileMeta: document.getElementById("selectedFileMeta"),
  quotaBar: document.getElementById("quotaBar"),
  quotaPercent: document.getElementById("quotaPercent"),
  quotaPlan: document.getElementById("quotaPlan"),
  quotaTotal: document.getElementById("quotaTotal"),
  quotaUsed: document.getElementById("quotaUsed"),
  quotaDrive: document.getElementById("quotaDrive"),
  fileCount: document.getElementById("fileCount"),
  totalFileSize: document.getElementById("totalFileSize"),
  largestFile: document.getElementById("largestFile"),
  lastSync: document.getElementById("lastSync"),
  fileSearchInput: document.getElementById("fileSearchInput"),
  fileSortSelect: document.getElementById("fileSortSelect"),
  fileSummary: document.getElementById("fileSummary"),
  filesBody: document.getElementById("filesBody"),
  output: document.getElementById("output"),
  toast: document.getElementById("toast"),
};

let currentFiles = [];
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
  elements.dropZone.classList.toggle("disabled", !enabled);
  elements.dropZone.setAttribute("aria-disabled", String(!enabled));

  if (!enabled) {
    elements.sessionPill.className = "session-pill disconnected";
    elements.sessionPill.innerHTML = '<span class="dot"></span>Not signed in';
    return;
  }

  elements.sessionPill.className = "session-pill connected";
  elements.sessionPill.innerHTML = '<span class="dot"></span>Logged in - Session active';
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
    const plan = quota.plan || "free";
    const fallbackLimit = plan === "premium" ? PREMIUM_STORAGE_LIMIT_BYTES : USER_STORAGE_LIMIT_BYTES;
    const limit = Number(quota.userLimit || fallbackLimit);
    const usage = Number(quota.userUsage || 0);
    const remaining = Math.max(limit - usage, 0);
    const percent = limit > 0 ? Math.min((usage / limit) * 100, 100) : 0;

    setQuotaMeter(percent);
    elements.quotaPlan.textContent = formatPlan(plan);
    elements.quotaTotal.textContent = formatBytes(limit);
    elements.quotaUsed.textContent = formatBytes(usage);
    elements.quotaDrive.textContent = formatBytes(remaining);
    updateLastSync();
  } catch (error) {
    setOutput(`ERROR:\n${error.message}`);
    showToast(error.message);
  }
}

function setQuotaMeter(percent) {
  elements.quotaBar.style.width = `${percent}%`;
  elements.quotaBar.className = percent >= 95 ? "danger" : percent >= 80 ? "warning" : "";
  elements.quotaPercent.textContent = `${formatPercent(percent)}%`;
}

async function loadFiles() {
  if (!token) return;

  setFilesMessage("Loading files...");
  try {
    const response = await apiFetch("/files", { headers: authHeaders() });
    const data = await response.json();
    renderFiles(data.files || []);
    setOutput("Files loaded.");
    updateLastSync();
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
  if (file.size > MAX_UPLOAD_BYTES) {
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
    updateSelectedFile();
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
  currentFiles = Array.isArray(files) ? files : [];
  updateFileStats(currentFiles);
  applyFilesView();
}

function applyFilesView() {
  const visibleFiles = sortFiles(filterFiles(currentFiles));
  updateFileSummary(visibleFiles);

  elements.filesBody.innerHTML = "";
  if (currentFiles.length === 0) {
    setFilesMessage("No files uploaded yet.");
    return;
  }

  if (visibleFiles.length === 0) {
    setFilesMessage("No files match your search.");
    return;
  }

  for (const file of visibleFiles) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><div class="file-name"></div></td>
      <td><span class="type-pill"></span></td>
      <td></td>
      <td></td>
      <td><div class="file-actions"></div></td>
    `;

    row.children[0].querySelector(".file-name").textContent = file.name || "-";
    const typePill = row.children[1].querySelector(".type-pill");
    typePill.textContent = formatMimeType(file.mimeType);
    typePill.title = file.mimeType || "Unknown type";
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

function filterFiles(files) {
  const query = elements.fileSearchInput.value.trim().toLowerCase();
  if (!query) return files;

  return files.filter((file) => {
    const name = String(file.name || "").toLowerCase();
    const type = String(file.mimeType || "").toLowerCase();
    return name.includes(query) || type.includes(query);
  });
}

function sortFiles(files) {
  const sorted = [...files];
  switch (elements.fileSortSelect.value) {
    case "name-asc":
      sorted.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
      break;
    case "size-desc":
      sorted.sort((a, b) => Number(b.size || 0) - Number(a.size || 0));
      break;
    case "type-asc":
      sorted.sort((a, b) => String(a.mimeType || "").localeCompare(String(b.mimeType || "")));
      break;
    case "modified-desc":
    default:
      sorted.sort((a, b) => dateValue(b.modifiedTime) - dateValue(a.modifiedTime));
      break;
  }
  return sorted;
}

function setFilesMessage(message) {
  elements.filesBody.innerHTML = `<tr><td colspan="5" class="empty"></td></tr>`;
  elements.filesBody.querySelector("td").textContent = message;
}

function updateFileStats(files) {
  const totalBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
  const largest = files.reduce((winner, file) => {
    return Number(file.size || 0) > Number(winner?.size || 0) ? file : winner;
  }, null);

  elements.fileCount.textContent = String(files.length);
  elements.totalFileSize.textContent = formatBytes(totalBytes);
  elements.largestFile.textContent = largest ? formatBytes(Number(largest.size || 0)) : "-";
}

function updateFileSummary(visibleFiles) {
  const totalBytes = visibleFiles.reduce((sum, file) => sum + Number(file.size || 0), 0);
  if (currentFiles.length === 0) {
    elements.fileSummary.textContent = "No files loaded yet.";
    return;
  }

  if (visibleFiles.length !== currentFiles.length) {
    const totalLabel = currentFiles.length === 1 ? "file" : "files";
    elements.fileSummary.textContent = `${visibleFiles.length} of ${currentFiles.length} ${totalLabel} shown - ${formatBytes(totalBytes)}`;
    return;
  }

  const fileLabel = visibleFiles.length === 1 ? "file" : "files";
  elements.fileSummary.textContent = `${visibleFiles.length} ${fileLabel} - ${formatBytes(totalBytes)} total`;
}

function updateSelectedFile() {
  const file = elements.fileInput.files[0];
  elements.dropZone.classList.toggle("file-too-large", Boolean(file && file.size > MAX_UPLOAD_BYTES));

  if (!file) {
    elements.selectedFileName.textContent = "No file selected";
    elements.selectedFileMeta.textContent = "Drop a file here or browse from your device.";
    elements.uploadHint.textContent = "Maximum upload size is 25 MB.";
    return;
  }

  elements.selectedFileName.textContent = file.name;
  elements.selectedFileMeta.textContent = `${formatBytes(file.size)} - ${file.type || "Unknown type"}`;
  elements.uploadHint.textContent = file.size > MAX_UPLOAD_BYTES
    ? "This file is larger than the 25 MB upload limit."
    : "Ready to upload.";
}

function setupDropZone() {
  ["dragenter", "dragover"].forEach((eventName) => {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.add("drag-over");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.remove("drag-over");
    });
  });

  elements.dropZone.addEventListener("drop", (event) => {
    if (event.dataTransfer?.files?.length) {
      elements.fileInput.files = event.dataTransfer.files;
      updateSelectedFile();
    }
  });

  elements.dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      elements.fileInput.click();
    }
  });
}

function updateLastSync() {
  elements.lastSync.textContent = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function dateValue(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatPercent(value) {
  return value > 0 && value < 10 ? value.toFixed(1) : String(Math.round(value));
}

function formatPlan(plan) {
  return plan === "premium" ? "Premium" : "Free";
}

function formatMimeType(value) {
  if (!value) return "Unknown";
  if (value === "application/pdf") return "PDF";
  if (value.startsWith("image/")) return "Image";
  if (value.startsWith("video/")) return "Video";
  if (value.startsWith("audio/")) return "Audio";
  if (value.startsWith("text/")) return "Text";
  if (value.includes("spreadsheet")) return "Spreadsheet";
  if (value.includes("presentation")) return "Presentation";
  if (value.includes("document") || value.includes("word")) return "Document";
  return value.split("/").pop().replace(/[.+-]/g, " ").trim() || value;
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
  elements.fileInput.addEventListener("change", updateSelectedFile);
  elements.fileSearchInput.addEventListener("input", applyFilesView);
  elements.fileSortSelect.addEventListener("change", applyFilesView);
  setupDropZone();

  renderSession();
  updateSelectedFile();
  checkService();
  Promise.all([loadQuota(), loadFiles()]);
}

init();
