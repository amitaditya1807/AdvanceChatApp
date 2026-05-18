const API_GATEWAY_URL = "https://apigateway1-khy4.onrender.com";
const TOKEN_KEY = "advanced_chat_jwt";

const token = localStorage.getItem(TOKEN_KEY) || "";
const params = new URLSearchParams(location.search);
const roomId = params.get("roomId") || "";
const roomName = params.get("roomName") || "Room";
const password = getRoomPassword(roomId);

const messagesEl = document.getElementById("messages");
const input = document.getElementById("messageInput");
const roomTitle = document.getElementById("roomTitle");
const roomMeta = document.getElementById("roomMeta");
const peopleCountBadge = document.getElementById("peopleCountBadge");

let me = "";
let roomStateTimer = null;
let heartbeatTimer = null;
let joinedPeople = [];

roomTitle.textContent = decodeURIComponent(roomName);
if (!isTokenActive(token)) {
  redirectHome(token ? "expired" : "");
} else if (!roomId || !password) {
  roomMeta.textContent = "Missing room or password.";
} else {
  me = getCurrentUserId();
  roomMeta.textContent = "Connected";
  startLiveRoomUpdates();
}

window.addEventListener("beforeunload", stopLiveRoomUpdates);
window.addEventListener("pagehide", stopLiveRoomUpdates);
window.addEventListener("storage", (event) => {
  if (event.key === TOKEN_KEY && !isTokenActive(event.newValue || "")) {
    redirectHome("expired");
  }
});
window.addEventListener("pageshow", () => {
  if (token && roomId && password) startLiveRoomUpdates();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && token && roomId && password) {
    startLiveRoomUpdates();
  } else if (document.visibilityState === "hidden") {
    stopLiveRoomUpdates();
  }
});

function goHome() {
  location.href = "../../index.html";
}

function goBack() {
  location.href = "../index.html";
}

function redirectHome(reason = "") {
  stopLiveRoomUpdates();
  localStorage.removeItem(TOKEN_KEY);
  const suffix = reason ? `&reason=${encodeURIComponent(reason)}` : "";
  window.location.replace(`../../index.html?authRequired=room${suffix}`);
}

function handleKey(e) {
  if (e.key === "Enter") sendMessage();
}

function getRoomPassword(roomId) {
  return localStorage.getItem(`room_password_${roomId}`) || sessionStorage.getItem(`room_password_${roomId}`) || "";
}

async function api(path, options = {}) {
  const res = await fetch(`${API_GATEWAY_URL}${path}`, {
    method: options.method || "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(password ? { "X-Room-Password": password } : {})
    },
    body: options.body
  });

  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }

  if (!res.ok) {
    if (res.status === 401) {
      redirectHome("expired");
      return null;
    }
    const message = typeof body === "string" ? body : (body?.error || `Status ${res.status}`);
    throw new Error(message);
  }

  return body;
}

function startLiveRoomUpdates() {
  stopLiveRoomUpdates();
  touchParticipant();
  loadRoomState(false);

  heartbeatTimer = setInterval(touchParticipant, 4000);
  roomStateTimer = setInterval(() => loadRoomState(false), 1000);
}

function stopLiveRoomUpdates() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (roomStateTimer) clearInterval(roomStateTimer);
  heartbeatTimer = null;
  roomStateTimer = null;
}

async function touchParticipant() {
  try {
    await api(`/chat/rooms/${roomId}/participants/heartbeat`, { method: "POST" });
  } catch (error) {
    roomMeta.textContent = error.message || "Failed to update presence";
  }
}

async function loadRoomState(showStatus) {
  try {
    const [messages, participants] = await Promise.all([
      api(`/chat/rooms/${roomId}/messages`),
      api(`/chat/rooms/${roomId}/participants`)
    ]);

    setParticipants(participants || []);
    render(messages || []);

    if (showStatus) roomMeta.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    roomMeta.textContent = error.message || "Failed to load room";
  }
}

async function loadMessages(showStatus) {
  await touchParticipant();
  await loadRoomState(showStatus);
}

function setParticipants(participants) {
  const uniqueParticipants = new Map();

  (participants || []).forEach((participant) => {
    const normalized = normalizeParticipant(participant);
    if (!normalized) return;
    uniqueParticipants.set(normalized.key, normalized.name);
  });

  joinedPeople = [...uniqueParticipants.values()];
  peopleCountBadge.textContent = `${joinedPeople.length}`;
}

function normalizeParticipant(participant) {
  if (!participant) return null;

  if (typeof participant === "string") {
    return { key: participant, name: participant };
  }

  const userId = participant.userId || participant.UserId || "";
  const displayName = participant.displayName || participant.DisplayName || userId || "Chat user";
  return { key: userId || displayName, name: displayName };
}

function render(list) {
  messagesEl.innerHTML = list.map(m => {
    const isYou = me && (m.senderUserId === me);
    return `<div class="bubble ${isYou ? "you" : "other"}">${escapeHtml(m.content)}<span class="meta">${escapeHtml(m.senderName)} • ${new Date(m.sentAtUtc).toLocaleTimeString()}</span></div>`;
  }).join("") || '<div class="meta">No messages yet.</div>';

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function sendMessage() {
  const content = input.value.trim();
  if (!content) return;
  input.value = "";

  try {
    await api(`/chat/rooms/${roomId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content })
    });

    await loadRoomState(false);
  } catch (error) {
    roomMeta.textContent = error.message || "Failed to send message";
  }
}

function showPeopleList() {
  loadRoomState(false).finally(() => {
    if (!joinedPeople.length) {
      alert("No people joined yet.");
      return;
    }
    alert(`People joined (${joinedPeople.length}):\n- ${joinedPeople.join("\n- ")}`);
  });
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

function getCurrentUserId() {
  const p = decodeJwtPayload(token);
  return p?.["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"] || p?.sub || "";
}

function escapeHtml(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
