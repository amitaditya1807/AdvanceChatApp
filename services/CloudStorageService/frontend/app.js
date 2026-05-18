const elements = {
  apiBase: document.querySelector("#apiBase"),
  jwtToken: document.querySelector("#jwtToken"),
  serviceStatus: document.querySelector("#serviceStatus"),
  saveApiButton: document.querySelector("#saveApiButton"),
  saveTokenButton: document.querySelector("#saveTokenButton"),
  clearTokenButton: document.querySelector("#clearTokenButton"),
  refreshQuotaButton: document.querySelector("#refreshQuotaButton"),
  refreshFilesButton: document.querySelector("#refreshFilesButton"),
  uploadButton: document.querySelector("#uploadButton"),
  fileInput: document.querySelector("#fileInput"),
  uploadHint: document.querySelector("#uploadHint"),
  quotaBar: document.querySelector("#quotaBar"),
  quotaPlan: document.querySelector("#quotaPlan"),
  quotaTotal: document.querySelector("#quotaTotal"),
  quotaUsed: document.querySelector("#quotaUsed"),
  quotaDrive: document.querySelector("#quotaDrive"),
  filesBody: document.querySelector("#filesBody"),
  toast: document.querySelector("#toast"),
};

const USER_STORAGE_LIMIT_BYTES = 100 * 1024 * 1024;
const PREMIUM_STORAGE_LIMIT_BYTES = 200 * 1024 * 1024;

const storageKeys = {
  apiBase: "cloudStorage.apiBase",
  token: "cloudStorage.jwt",
};

function getApiBase() {
  return elements.apiBase.value.trim().replace(/\/+$/, "");
}

function getToken() {
  return elements.jwtToken.value.trim();
}

function authHeaders() {
  const token = getToken();
  if (!token) {
    throw new Error("Paste and save your Auth service JWT first.");
  }
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
    const message = await readError(response);
    throw new Error(message || `Request failed with ${response.status}`);
  }

  return response;
}

async function readError(response) {
  const text = await response.text();
  if (!text) {
    return "";
  }
  try {
    return JSON.parse(text).error || text;
  } catch {
    return text;
  }
}

async function checkService() {
  try {
    await apiFetch("/");
    setStatus("Service online", "ok");
  } catch (error) {
    setStatus("Service offline", "bad");
  }
}

function setStatus(text, state) {
  elements.serviceStatus.textContent = text;
  elements.serviceStatus.className = `status ${state}`;
}

async function loadQuota() {
  try {
    const response = await apiFetch("/storage", {
      headers: authHeaders(),
    });
    const quota = await response.json();
    const plan = quota.plan || "free";
    const fallbackLimit = plan === "premium" ? PREMIUM_STORAGE_LIMIT_BYTES : USER_STORAGE_LIMIT_BYTES;
    const limit = Number(quota.userLimit || fallbackLimit);
    const usage = Number(quota.userUsage || 0);
    const remaining = Math.max(limit - usage, 0);
    const percent = limit > 0 ? Math.min((usage / limit) * 100, 100) : 0;

    elements.quotaBar.style.width = `${percent}%`;
    elements.quotaPlan.textContent = formatPlan(plan);
    elements.quotaTotal.textContent = formatBytes(limit);
    elements.quotaUsed.textContent = formatBytes(usage);
    elements.quotaDrive.textContent = formatBytes(remaining);
  } catch (error) {
    showToast(error.message);
  }
}

async function loadFiles() {
  setFilesMessage("Loading files...");
  try {
    const response = await apiFetch("/files", {
      headers: authHeaders(),
    });
    const data = await response.json();
    renderFiles(data.files || []);
  } catch (error) {
    setFilesMessage(error.message);
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
    showToast("File uploaded.");
    await Promise.all([loadQuota(), loadFiles()]);
  } catch (error) {
    elements.uploadHint.textContent = error.message;
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
    showToast(error.message);
  }
}

async function deleteFile(file) {
  const confirmed = window.confirm(`Delete "${file.name}"?`);
  if (!confirmed) {
    return;
  }

  try {
    await apiFetch(`/files/${encodeURIComponent(file.id)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    showToast("File deleted.");
    await Promise.all([loadQuota(), loadFiles()]);
  } catch (error) {
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
    downloadButton.textContent = "Download";
    downloadButton.addEventListener("click", () => downloadFile(file));

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "danger";
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
  if (!bytes) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatPlan(plan) {
  return plan === "premium" ? "Premium" : "Free";
}

function formatDate(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
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
  localStorage.setItem(storageKeys.apiBase, getApiBase());
  showToast("API URL saved.");
  checkService();
}

function saveToken() {
  localStorage.setItem(storageKeys.token, getToken());
  showToast("Token saved.");
  Promise.all([loadQuota(), loadFiles()]);
}

function clearToken() {
  elements.jwtToken.value = "";
  localStorage.removeItem(storageKeys.token);
  showToast("Token cleared.");
}

function init() {
  elements.apiBase.value = localStorage.getItem(storageKeys.apiBase) || elements.apiBase.value;
  elements.jwtToken.value = localStorage.getItem(storageKeys.token) || "";

  elements.saveApiButton.addEventListener("click", saveApiBase);
  elements.saveTokenButton.addEventListener("click", saveToken);
  elements.clearTokenButton.addEventListener("click", clearToken);
  elements.refreshQuotaButton.addEventListener("click", loadQuota);
  elements.refreshFilesButton.addEventListener("click", loadFiles);
  elements.uploadButton.addEventListener("click", uploadFile);

  checkService();
  if (getToken()) {
    Promise.all([loadQuota(), loadFiles()]);
  }
}

init();
