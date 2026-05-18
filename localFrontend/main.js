const API_GATEWAY_URL = "https://localhost:7000";
const TOKEN_KEY = "advanced_chat_jwt";

const output = document.getElementById("output");
const chatButton = document.getElementById("chatButton");
const roomServiceButton = document.getElementById("roomServiceButton");
const sessionText = document.getElementById("sessionText");
const sessionBadge = document.getElementById("sessionBadge");
const tokenPreview = document.getElementById("tokenPreview");
const gatewayUrl = document.getElementById("gatewayUrl");

gatewayUrl.textContent = API_GATEWAY_URL;

const authParams = new URLSearchParams(window.location.search);
const authRequired = authParams.get("authRequired");
const authReason = authParams.get("reason");

let token = readTokenFromUrl() || localStorage.getItem(TOKEN_KEY) || "";
if (token && isTokenActive(token)) {
  localStorage.setItem(TOKEN_KEY, token);
  removeTokenFromUrl();
} else {
  token = "";
  localStorage.removeItem(TOKEN_KEY);
}

renderSession();

if (authRequired === "room" && !token) {
  output.textContent = "❌ Please sign in with Google before opening Room Service.";
}

if (authRequired && !token) {
  const serviceName = authRequired === "cloudstorage" ? "CloudStorage" : "Room Service";
  output.textContent = authReason === "expired"
    ? `Your session expired. Please sign in again before opening ${serviceName}.`
    : `Please sign in with Google before opening ${serviceName}.`;
}

window.addEventListener("storage", (event) => {
  if (event.key !== TOKEN_KEY) return;
  token = event.newValue && isTokenActive(event.newValue) ? event.newValue : "";
  if (!token) localStorage.removeItem(TOKEN_KEY);
  renderSession();
});

function readTokenFromUrl() {
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return query.get("token") || hash.get("token") || "";
}

function removeTokenFromUrl() {
  window.history.replaceState({}, document.title, window.location.pathname || "/");
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

function renderSession() {
  if (!token) {
    sessionText.textContent = "Not signed in";
    sessionBadge.className = "badge";
    sessionBadge.innerHTML = '<span class="dot"></span>Disconnected';
    tokenPreview.textContent = "No token stored";
    roomServiceButton.disabled = true;
    return;
  }

  sessionText.textContent = "JWT stored in this browser";
  sessionBadge.className = "badge connected";
  sessionBadge.innerHTML = '<span class="dot"></span>Connected';
  tokenPreview.textContent = token.length > 34 ? `${token.slice(0, 18)}...${token.slice(-12)}` : token;
  roomServiceButton.disabled = false;
}

function login() {
  window.location.href = `${API_GATEWAY_URL}/auth/google/login`;
}

function openRoomService() {
  if (!token) {
    output.textContent = "❌ Please sign in with Google before opening Room Service.";
    return;
  }

  window.location.href = "./room/index.html";
}

async function callChatService() {
  if (!token) {
    output.textContent = "❌ Please sign in with Google first.";
    return;
  }

  try {
    chatButton.disabled = true;
    output.textContent = "⏳ Checking ChatService...";

    const response = await fetch(`${API_GATEWAY_URL}/chat`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const text = await response.text();
    let body = text;
    try { body = text ? JSON.parse(text) : null; } catch {}

    if (!response.ok) {
      if (response.status === 401) {
        logout();
        output.textContent = "Your session expired. Please sign in again.";
        return;
      }
      output.textContent = `❌ ERROR:\nStatus: ${response.status}\n${typeof body === "string" ? body : JSON.stringify(body, null, 2)}`;
      return;
    }

    output.textContent = `✅ ChatService reachable\n\n${JSON.stringify(body, null, 2)}`;
  } catch (e) {
    output.textContent = `❌ ERROR:\n${e.message}`;
  } finally {
    chatButton.disabled = false;
  }
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  token = "";
  renderSession();
  output.textContent = "👋 Logged out.";
}

function clearOutput() {
  output.textContent = "Ready.";
}
