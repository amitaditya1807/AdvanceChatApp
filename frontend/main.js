const API_GATEWAY_URL = "https://apigateway1-khy4.onrender.com";
const TOKEN_KEY = "advanced_chat_jwt";
const WAKE_RETRY_STATUSES = [502, 503, 504];
const WAKE_RETRY_ATTEMPTS = 10;
const WAKE_RETRY_DELAY_MS = 3000;

const output = document.getElementById("output");
const chatButton = document.getElementById("chatButton");
const roomServiceButton = document.getElementById("roomServiceButton");
const cloudStorageButton = document.getElementById("cloudStorageButton");
const sessionPill = document.getElementById("sessionPill");

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
if (authRequired === "cloudstorage" && !token) {
  output.textContent = "❌ Please sign in with Google before opening CloudStorage.";
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
    sessionPill.className = "session-pill disconnected";
    sessionPill.innerHTML = '<span class="dot"></span>Not signed in';
    roomServiceButton.disabled = true;
    cloudStorageButton.disabled = true;
    return;
  }

  sessionPill.className = "session-pill connected";
  sessionPill.innerHTML = '<span class="dot"></span>Logged in · Session active';
  roomServiceButton.disabled = false;
  cloudStorageButton.disabled = false;
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

function openCloudStorage() {
  if (!token) {
    output.textContent = "❌ Please sign in with Google before opening CloudStorage.";
    return;
  }

  window.location.href = "./cloudstorage/index.html";
}

async function callChatService() {
  if (!token) {
    output.textContent = "❌ Please sign in with Google first.";
    return;
  }

  try {
    chatButton.disabled = true;
    output.textContent = "⏳ Checking ChatService...";

    const { response, body } = await requestGateway("/chat", {
      headers: { Authorization: `Bearer ${token}` },
      onWakeRetry: (status, attempt, maxAttempts) => {
        output.textContent = [
          "Waiting for ChatService to wake up...",
          `Gateway status: ${status}`,
          `Attempt ${attempt + 1} of ${maxAttempts}`
        ].join("\n");
      }
    });

    if (!response.ok) {
      if (response.status === 401) {
        if (!isTokenActive(token)) {
          logout();
          output.textContent = "Your session expired. Please sign in again.";
          return;
        }
        output.textContent = [
          "ChatService rejected the current JWT.",
          "Check that AuthService and ChatService use the same Jwt:Key, Jwt:Issuer, and Jwt:Audience."
        ].join("\n");
        return;
      }
      if ([502, 503, 504].includes(response.status)) {
        output.textContent = `ChatService is still waking up.\nStatus: ${response.status}\nPlease try again in a moment.`;
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

async function requestGateway(path, options = {}) {
  const { onWakeRetry, ...fetchOptions } = options;

  for (let attempt = 0; attempt < WAKE_RETRY_ATTEMPTS; attempt++) {
    const response = await fetch(`${API_GATEWAY_URL}${path}`, fetchOptions);
    const body = await readResponseBody(response);

    if (!WAKE_RETRY_STATUSES.includes(response.status) || attempt === WAKE_RETRY_ATTEMPTS - 1) {
      return { response, body };
    }

    if (onWakeRetry) onWakeRetry(response.status, attempt, WAKE_RETRY_ATTEMPTS);
    await sleep(WAKE_RETRY_DELAY_MS);
  }
}

async function readResponseBody(response) {
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";

  try {
    return text && contentType.includes("application/json") ? JSON.parse(text) : text;
  } catch {
    return text;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
