const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const categories = ["Tout", "Mode", "Maison", "Tech", "Beauté", "Créateurs", "Autre"];
const MAX_PARALLEL_UPLOADS = 4;
const pointPackages = [
  { points: 10, price: 10, label: "10 points", detail: "10 DT · 10 photos ou 5 vidéos" },
  { points: 4, price: 4, label: "Pack mixte", detail: "4 DT · jusqu'à 2 photos + 1 vidéo" },
];
const SIGNUP_COOLDOWN_PREFIX = "souqna-signup-email-cooldown:";
const PKCE_VERIFIER_KEY = "souqna-google-pkce-verifier";
let reelObserver;
let messageRecorder = null;
let messageRecorderStream = null;
let recordedMessageFile = null;
let messageRecorderChunks = [];
let imageViewerScale = 1;
let imageViewerOffset = { x: 0, y: 0 };
const state = {
  config: null, session: null, profile: null, page: "feed", category: "Tout",
  search: "", authMode: "login", adminTab: "requests", savedOnly: false,
  requestCooldownUntil: 0, setupReady: false, schemaUpgradeRequired: false, guestMode: false,
};
const escapeHTML = (value = "") => String(value).replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));
const safeURL = value => {
  try {
    const url = new URL(value, window.location.origin);
    return ["https:", "http:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
};
const mediaURL = path => `${state.config.supabaseUrl}/storage/v1/object/public/marketplace-media/${path.split("/").map(encodeURIComponent).join("/")}`;
const initials = name => (name || "S").trim().split(/\s+/).slice(0, 2).map(part => part[0] || "").join("").toUpperCase();
const money = amount => `${Number(amount).toLocaleString("fr-TN", { maximumFractionDigits: 3 })} DT`;
const currentUserId = () => state.session?.user?.id;
const sessionToken = () => state.session?.access_token;

async function responseJSON(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Réponse invalide du serveur (${response.status}).`);
  }
}

function requireSignIn() {
  state.guestMode = false;
  setAuthScreen(false);
  authModeChanged($('[data-auth-mode="login"]'));
  $("#guest-continue").classList.remove("hidden");
  showAuthError("باش تعمل هالعملية، سجّل الدخول ولا أنشئ حساب. تنجم ترجع تتفرّج من غير حساب.");
}

function toast(message, error = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error", error);
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 3300);
}

function authHeaders(token = sessionToken()) {
  if (!state.config) throw new Error("Supabase n'est pas configuré. Vérifie le fichier .env.");
  const headers = { apikey: state.config.supabaseKey };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function signupCooldownKey(email) {
  return `${SIGNUP_COOLDOWN_PREFIX}${email.trim().toLowerCase()}`;
}

function signupCooldownRemaining(email) {
  const until = Number(localStorage.getItem(signupCooldownKey(email)) || 0);
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

function passwordRequirements(password) {
  return {
    length: password.length >= 8,
    upper: /[A-Z]/.test(password),
    lower: /[a-z]/.test(password),
    number: /\d/.test(password),
    symbol: /[^A-Za-z0-9]/.test(password),
  };
}

function showAuthError(message, { offerLogin = false } = {}) {
  $("#auth-error").textContent = message;
  $("#auth-switch-to-login").classList.toggle("hidden", !offerLogin);
}

function isExistingAccountError(error) {
  return /user already registered|already registered|already exists|email.*already|already.*email/i
    .test(`${error.code || ""} ${error.message || ""}`);
}

function authModeChanged(button) {
  state.authMode = button.dataset.authMode;
  const signup = state.authMode === "signup";
  $$("[data-auth-mode]").forEach(tab => tab.classList.toggle("active", tab === button));
  $("#name-field").classList.toggle("hidden", !signup);
  const passwordInput = $('input[name="password"]');
  passwordInput.autocomplete = signup ? "new-password" : "current-password";
  passwordInput.minLength = signup ? 8 : 6;
  $("#password-rules").classList.toggle("hidden", !signup);
  updatePasswordRules();
  $("#auth-title").textContent = signup ? "Bienvenue au marché." : "Ravi de te revoir.";
  $("#auth-description").textContent = signup ? "Ton compte commence avec 2 points offerts ✦" : "Connecte-toi pour retrouver ton marché.";
  refreshSignupButton();
  showAuthError("");
}

function updatePasswordRules() {
  const password = $('input[name="password"]').value;
  const requirements = passwordRequirements(password);
  for (const [name, passed] of Object.entries(requirements)) {
    const rule = $(`[data-rule="${name}"]`);
    rule.classList.toggle("passed", passed);
    rule.textContent = `${passed ? "✓" : "○"} ${rule.textContent.replace(/^[✓○]\s*/, "")}`;
  }
  return Object.values(requirements).every(Boolean);
}

function refreshSignupButton() {
  const button = $("#auth-submit");
  if (!button) return;
  const isSignup = state.authMode === "signup";
  const seconds = Math.max(
    Math.ceil((state.requestCooldownUntil - Date.now()) / 1000),
    isSignup ? signupCooldownRemaining($('input[name="email"]').value) : 0,
    0,
  );
  button.disabled = Boolean(authRequest.pending) || seconds > 0;
  button.innerHTML = seconds > 0
    ? `Réessaie dans ${seconds} s`
    : isSignup ? "Créer mon compte <span>→</span>" : "Se connecter <span>→</span>";
}

function startAuthCooldown(seconds) {
  state.requestCooldownUntil = Date.now() + seconds * 1000;
  clearInterval(startAuthCooldown.timer);
  startAuthCooldown.timer = setInterval(() => {
    refreshSignupButton();
    if (Date.now() >= state.requestCooldownUntil) {
      clearInterval(startAuthCooldown.timer);
      startAuthCooldown.timer = null;
    }
  }, 1000);
  refreshSignupButton();
}

function startSignupCooldown(email, seconds) {
  const duration = Math.max(1, Math.min(3600, seconds));
  localStorage.setItem(signupCooldownKey(email), String(Date.now() + duration * 1000));
  clearInterval(startSignupCooldown.timer);
  startSignupCooldown.timer = setInterval(() => {
    refreshSignupButton();
    if (!signupCooldownRemaining($('input[name="email"]').value)) {
      clearInterval(startSignupCooldown.timer);
      startSignupCooldown.timer = null;
    }
  }, 1000);
  refreshSignupButton();
}

async function authRequest(path, body) {
  const response = await fetch(`${state.config.supabaseUrl}/auth/v1/${path}`, {
    method: "POST",
    headers: { ...authHeaders(null), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await responseJSON(response) || {};
  if (!response.ok) {
    const error = new Error(data.msg || data.message || data.error_description || data.error || "Connexion impossible.");
    error.status = response.status;
    error.code = data.code || data.error_code || data.error || "";
    error.retryAfter = Number(response.headers.get("retry-after") || data.retry_after || 0);
    throw error;
  }
  return data;
}

async function signInWithGoogle() {
  if (!state.config) throw new Error("Supabase n'est pas configuré.");
  if (!state.setupReady) throw new Error("Installe d'abord le script SQL Marketplace TN dans Supabase.");
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = btoa(String.fromCharCode(...randomBytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  localStorage.setItem(PKCE_VERIFIER_KEY, verifier);
  window.location.assign(`/api/auth/google?code_challenge=${encodeURIComponent(challenge)}`);
}

async function api(path, { method = "GET", body, query = "", headers: extraHeaders = {} } = {}) {
  const publicRead = !sessionToken()
    && method === "GET"
    && ["posts", "public_profiles", "comments"].includes(path);
  if (!sessionToken() && !publicRead) throw new Error("Ta session a expiré. Reconnecte-toi.");
  const response = await fetch(`/api/rest/${path}${query ? `?${query}` : ""}`, {
    method,
    headers: {
      ...authHeaders(publicRead ? null : sessionToken()),
      ...extraHeaders,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(method === "POST" ? { Prefer: "return=representation" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const detail = data?.message || data?.details || data?.hint || data?.error_description || data?.msg || data?.detail;
    throw new Error(detail || "Une erreur est survenue. Réessaie.");
  }
  return data;
}

async function apiCount(resource, query = "") {
  const suffix = query ? `&${query}` : "";
  const response = await fetch(`/api/rest/${resource}?select=id&limit=1${suffix}`, {
    headers: { ...authHeaders(), Prefer: "count=exact", Range: "0-0" },
  });
  if (!response.ok) {
    const data = await responseJSON(response);
    throw new Error(data?.message || data?.detail || `Impossible de compter ${resource}.`);
  }
  await response.arrayBuffer();
  const match = response.headers.get("content-range")?.match(/\/(\d+|\*)$/);
  if (!match || match[1] === "*") throw new Error(`Le total de ${resource} n'a pas été renvoyé.`);
  return Number(match[1]);
}

async function rpc(name, args) {
  return api(`rpc/${name}`, { method: "POST", body: args });
}

function updateUploadProgress(percent, message = `Envoi du fichier... ${percent}%`) {
  const progress = $("#upload-progress");
  if (!progress) return;
  progress.classList.remove("hidden");
  $("span", progress).textContent = message;
  $("progress", progress).value = percent;
  $("b", progress).textContent = `${percent}%`;
}

async function upload(file, bucket = "marketplace-media", onProgress = () => {}) {
  const mimeType = file.type.split(";")[0].toLowerCase();
  const isMessageMedia = bucket === "marketplace-message-media";
  const allowed = isMessageMedia
    ? /^(image\/(jpeg|png|webp)|audio\/(webm|ogg|mp4|mpeg|wav|x-m4a))$/
    : /^(image\/(jpeg|png|webp)|video\/(mp4|webm|quicktime))$/;
  if (!allowed.test(mimeType)) {
    throw new Error(isMessageMedia
      ? "Format refusé. Utilise une photo JPG, PNG, WebP ou un audio WebM, OGG, MP4, WAV ou M4A."
      : "Format refusé. Utilise JPG, PNG, WebP, MP4, WebM ou MOV.");
  }
  const maxBytes = bucket === "marketplace-receipts" ? 10 * 1024 * 1024
    : isMessageMedia || (bucket === "marketplace-media" && mimeType.startsWith("image/")) ? 20 * 1024 * 1024
      : 100 * 1024 * 1024;
  if (file.size > maxBytes) throw new Error(`Le fichier dépasse la limite de ${maxBytes / (1024 * 1024)} Mo.`);
  const ext = file.name.split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  const objectName = `${currentUserId()}/${crypto.randomUUID()}.${ext}`;
  const result = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/storage/upload/object/${bucket}/${objectName}`);
    for (const [name, value] of Object.entries({
      ...authHeaders(),
      "Content-Type": mimeType,
      "x-upsert": "false",
      ...(bucket === "marketplace-media" ? { "Cache-Control": "max-age=31536000" } : {}),
    })) xhr.setRequestHeader(name, value);
    xhr.upload.addEventListener("progress", event => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener("load", () => {
      let data = {};
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : {}; } catch {
        reject(new Error(`Réponse invalide du serveur (${xhr.status}).`));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(data.message || data.error || data.detail || "Échec de l'envoi du fichier."));
        return;
      }
      onProgress(100);
      resolve(data);
    });
    xhr.addEventListener("error", () => reject(new Error("Connexion interrompue pendant l'envoi. Vérifie ta connexion et réessaie.")));
    xhr.addEventListener("timeout", () => reject(new Error("L'envoi prend trop de temps. Vérifie ta connexion et réessaie.")));
    xhr.timeout = 180000;
    xhr.send(file);
  });
  if (!result) throw new Error("Supabase n'a pas confirmé l'envoi du fichier.");
  return objectName;
}

async function uploadMany(files, bucket, onProgress) {
  const sizes = files.map(file => file.size);
  const progress = files.map(() => 0);
  const uploaded = new Array(files.length);
  let nextIndex = 0;
  const report = () => {
    const totalBytes = sizes.reduce((total, size) => total + size, 0) || 1;
    const uploadedBytes = progress.reduce((total, percent, index) => total + sizes[index] * percent / 100, 0);
    onProgress(Math.round(uploadedBytes / totalBytes * 100));
  };
  const workers = Array.from({ length: Math.min(MAX_PARALLEL_UPLOADS, files.length) }, async () => {
    while (nextIndex < files.length) {
      const index = nextIndex++;
      uploaded[index] = await upload(files[index], bucket, percent => {
        progress[index] = percent;
        report();
      });
    }
  });
  await Promise.all(workers);
  onProgress(100);
  return uploaded;
}

async function signedPrivateObject(bucket, objectPath) {
  const safePath = objectPath.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`/api/storage/sign/${bucket}/${safePath}`, {
    method: "POST",
    headers: authHeaders(),
  });
  const data = await responseJSON(response) || {};
  if (!response.ok) throw new Error(data.message || data.error || data.detail || "Impossible d'afficher le justificatif.");
  const url = data.signedURL || data.signedUrl;
  if (!url) throw new Error("Supabase n'a pas renvoyé le lien sécurisé du justificatif.");
  return url.startsWith("/")
    ? `${state.config.supabaseUrl}/storage/v1${url}`
    : new URL(url, `${state.config.supabaseUrl}/storage/v1/`).href;
}

const signedReceipt = objectPath => signedPrivateObject("marketplace-receipts", objectPath);

function setAuthScreen(signedIn) {
  const showApp = signedIn || state.guestMode;
  $("#auth-screen").classList.toggle("hidden", showApp);
  $("#app-shell").classList.toggle("hidden", !showApp);
  $("#app-shell").classList.toggle("guest-mode", state.guestMode && !signedIn);
  $("#guest-login").classList.toggle("hidden", !state.guestMode || signedIn);
  $("#guest-continue").classList.toggle("hidden", !state.guestMode);
  $("#admin-nav").classList.toggle("hidden", !signedIn || !state.profile?.is_admin);
  if (signedIn) {
    $("#points-balance").textContent = state.profile?.points ?? 2;
    $("#avatar-button").textContent = initials(state.profile?.display_name);
  }
}

async function restoreSession() {
  const saved = localStorage.getItem("souqna-session");
  if (!saved) return null;
  try {
    const session = JSON.parse(saved);
    if (session.expires_at && session.expires_at * 1000 < Date.now() && session.refresh_token) {
      const refreshed = await authRequest("token?grant_type=refresh_token", { refresh_token: session.refresh_token });
      refreshed.expires_at = Math.floor(Date.now() / 1000) + (refreshed.expires_in || 3600);
      localStorage.setItem("souqna-session", JSON.stringify(refreshed));
      return refreshed;
    }
    return session;
  } catch (error) {
    localStorage.removeItem("souqna-session");
    $("#auth-error").textContent = `La session enregistrée n'a pas pu être restaurée. ${error.message}`;
    return null;
  }
}

async function signOut() {
  try {
    if (sessionToken()) {
      await fetch(`${state.config.supabaseUrl}/auth/v1/logout`, {
        method: "POST", headers: authHeaders(),
      });
    }
  } finally {
    localStorage.removeItem("souqna-session");
    state.session = null;
    state.profile = null;
    state.guestMode = true;
    setAuthScreen(false);
    state.page = "feed";
    await renderFeed();
  }
}

async function loadProfile() {
  const rows = await api("profiles", {
    query: `select=id,display_name,bio,avatar_url,points,is_admin,is_banned&id=eq.${currentUserId()}&limit=1`,
  });
  if (!rows?.length) throw new Error("Ton profil n'est pas encore prêt. Réessaie dans un instant.");
  state.profile = rows[0];
  if (state.profile.is_banned) {
    await signOut();
    $("#auth-error").textContent = "Ce compte a été suspendu. Contacte l'équipe Marketplace TN.";
    throw new Error("Ce compte a été suspendu.");
  }
  setAuthScreen(true);
}

function avatarHTML(profile, extra = "") {
  const url = profile?.avatar_url ? safeURL(mediaURL(profile.avatar_url)) : "";
  return url
    ? `<img class="avatar ${extra}" src="${escapeHTML(url)}" alt="" loading="lazy">`
    : `<span class="avatar ${extra}">${escapeHTML(initials(profile?.display_name))}</span>`;
}

function emptyHTML(icon, title, copy, action = "") {
  return `<div class="empty-card"><span>${icon}</span><h3>${escapeHTML(title)}</h3><p>${escapeHTML(copy)}</p>${action}</div>`;
}

function schemaUpgradeNotice() {
  return `<aside class="schema-upgrade-notice"><b>Mise à jour de la base requise</b><span>Pour activer les nouvelles fonctions (jusqu'à 6 photos, zoom, édition, messages vocaux et paiements), exécute la dernière version du script dans Supabase → SQL Editor.</span><a href="/setup.sql">Télécharger le script SQL</a></aside>`;
}

function pageHeading(title, subtitle, action = "") {
  return `<div class="page-heading"><div><span class="eyebrow">MARKETPLACE TN · TUNISIE</span><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`;
}

function updateNavigation() {
  $$(".nav-link[data-page], .mobile-nav [data-page], .admin-float[data-page]").forEach(button => {
    button.classList.toggle("active", button.dataset.page === state.page);
  });
}

function updateGalleryPosition(track) {
  if (!track) return;
  const gallery = track.closest(".post-gallery");
  const index = track.clientWidth ? Math.round(track.scrollLeft / track.clientWidth) : 0;
  const counter = $(".post-gallery-count", gallery);
  if (counter) counter.textContent = `${index + 1} / ${track.children.length} · اسحب للتبديل`;
  const previous = $('[data-action="gallery-previous"]', gallery);
  const next = $('[data-action="gallery-next"]', gallery);
  if (previous) previous.disabled = index === 0;
  if (next) next.disabled = index >= track.children.length - 1;
}

function openAdminAccessHelp() {
  const email = String(state.session?.user?.email || "").trim();
  const sql = email
    ? `update public.profiles\nset is_admin = true\nwhere id = (\n  select id from auth.users\n  where lower(email) = lower('${email.replace(/'/g, "''")}')\n);`
    : `update public.profiles\nset is_admin = true\nwhere id = '${currentUserId()}';`;
  openModal("Activer ton accès administrateur.", `
    <p class="muted">Ce compte n'a pas encore le rôle admin. Pour protéger le tableau de bord, les rôles se configurent dans Supabase — aucun PIN partagé n'ouvre l'administration.</p>
    <ol class="admin-setup-steps">
      <li>Ouvre ton projet Supabase puis <b>SQL Editor</b>.</li>
      <li>Copie la requête ci-dessous et exécute-la pour le compte actuellement connecté.</li>
      <li>Reviens ici et clique sur <b>Vérifier mon accès</b>.</li>
    </ol>
    <label class="field">Requête SQL pour ${escapeHTML(email || "ce compte")}
      <textarea id="admin-access-sql" readonly rows="5">${escapeHTML(sql)}</textarea>
    </label>
    <p id="admin-access-status" class="inline-note" aria-live="polite"></p>
    <div class="modal-actions">
      <button class="button button-light" type="button" data-action="close-modal">Fermer</button>
      <button class="button button-light" type="button" data-action="copy-admin-sql">Copier SQL</button>
      <button class="button button-dark" type="button" data-action="refresh-admin-role">Vérifier mon accès</button>
    </div>`);
}

async function refreshAdminRole() {
  await loadProfile();
  if (!state.profile?.is_admin) {
    $("#admin-access-status").textContent = "Le rôle n'est pas encore actif. Vérifie que la requête a bien été exécutée dans le bon projet Supabase.";
    return;
  }
  $("#modal-root").innerHTML = "";
  state.page = "admin";
  await renderPage();
}

function renderRail() {
  $("#right-rail").innerHTML = `
    <div class="rail-card"><div class="rail-title">À découvrir <span>✦</span></div>
      <div class="trend-item"><span class="trend-number">01</span><span class="trend-emoji">🧶</span><span><b>Fait main</b><small>Les créateurs du bled</small></span></div>
      <div class="trend-item"><span class="trend-number">02</span><span class="trend-emoji">👟</span><span><b>Mode & vintage</b><small>La seconde vie, bien portée</small></span></div>
      <div class="trend-item"><span class="trend-number">03</span><span class="trend-emoji">🏺</span><span><b>Maison</b><small>Des pièces avec une histoire</small></span></div>
    </div>
    <div class="rail-card tip-card"><div class="promo-star">✳</div><b>Un bon plan ?<br>Fais tourner.</b><p>Une photo coûte 1 point, une vidéo 2. Ton compte commence avec 2 points offerts.</p><button data-action="create">Publier maintenant →</button></div>
    <small class="muted" style="font-size:9px;padding:0 3px">À propos · Aide · Règles de la communauté<br>Marketplace TN</small>`;
}

function postCard(post, profile, likes, liked, saved, comments) {
  const mediaPaths = Array.isArray(post.media_urls) && post.media_urls.length
    ? post.media_urls
    : [post.media_url];
  const media = post.media_type === "video"
    ? `<video class="post-media video" src="${escapeHTML(safeURL(mediaURL(mediaPaths[0])))}" controls playsinline muted loop preload="metadata"></video>`
    : `<div class="post-gallery"><div class="post-gallery-track" aria-label="${mediaPaths.length} photos du produit">${mediaPaths.map((path, index) => {
      const source = escapeHTML(safeURL(mediaURL(path)));
      const alt = escapeHTML(`${post.product_name || "Produit partagé sur Marketplace TN"}${mediaPaths.length > 1 ? ` · photo ${index + 1}` : ""}`);
      return `<button class="post-gallery-slide" data-action="zoom-image" data-image="${source}" data-alt="${alt}" aria-label="Agrandir la photo ${index + 1} sur ${mediaPaths.length}"><img src="${source}" alt="${alt}" loading="${index ? "lazy" : "eager"}" decoding="async"><span>⤢ Agrandir</span></button>`;
    }).join("")}</div>${mediaPaths.length > 1 ? `<button class="post-gallery-arrow previous" data-action="gallery-previous" aria-label="Photo précédente" disabled>‹</button><button class="post-gallery-arrow next" data-action="gallery-next" aria-label="Photo suivante">›</button><small class="post-gallery-count" aria-live="polite">1 / ${mediaPaths.length} · اسحب للتبديل</small>` : ""}</div>`;
  const product = post.product_name
    ? `<div class="product-strip"><span class="product-glyph">✦</span><span class="product-info"><b>${escapeHTML(post.product_name)}</b><small>${escapeHTML(post.category || "Autre")}</small></span>${post.price === null || post.price === "" ? "" : `<span class="product-price">${money(post.price)}</span>`}</div>`
    : "";
  return `<article class="post-card" data-post-id="${escapeHTML(post.id)}" data-owner-id="${escapeHTML(post.user_id)}" data-media-type="${escapeHTML(post.media_type)}">
    <div class="post-head">${avatarHTML(profile)}<span class="post-user"><strong>${escapeHTML(profile?.display_name || "Membre Marketplace TN")}</strong><small>${new Date(post.created_at).toLocaleString("fr-TN", { dateStyle: "medium", timeStyle: "short" })} · ${escapeHTML(post.category || "Autre")}</small></span><button class="post-more" aria-label="Plus d'options" data-action="post-menu" data-post="${escapeHTML(post.id)}">···</button></div>
    ${post.caption ? `<div class="post-caption">${escapeHTML(post.caption)}</div>` : ""}
    ${media}${product}
    <div class="post-actions">
      <button class="icon-action ${liked ? "active" : ""}" data-action="like" data-post="${escapeHTML(post.id)}" aria-label="J'aime"><b>${liked ? "♥" : "♡"}</b> ${likes ?? ""}</button>
      <button class="icon-action" data-action="comments" data-post="${escapeHTML(post.id)}"><b>♧</b> ${comments}</button>
      <button class="icon-action ${saved ? "saved" : ""}" data-action="save" data-post="${escapeHTML(post.id)}"><b>${saved ? "▣" : "▢"}</b></button>
      ${post.user_id !== currentUserId() ? `<button class="message-seller contact-seller-cta" data-action="message" data-user="${escapeHTML(post.user_id)}" data-post="${escapeHTML(post.id)}"><span>Contact</span><small>Écrire au vendeur · message privé ↗</small></button>` : ""}
    </div>
  </article>`;
}

async function decoratePosts(posts) {
  if (!posts.length) return [];
  const ids = posts.map(post => post.id);
  const users = [...new Set(posts.map(post => post.user_id))];
  const idFilter = `(${ids.join(",")})`;
  const userFilter = `(${users.join(",")})`;
  const reads = [
    api("public_profiles", { query: `select=id,display_name,bio,avatar_url&id=in.${encodeURIComponent(userFilter)}` }),
    currentUserId()
      ? api("post_likes", { query: `select=post_id,user_id&post_id=in.${encodeURIComponent(idFilter)}` })
      : Promise.resolve([]),
    api("comments", { query: `select=post_id&post_id=in.${encodeURIComponent(idFilter)}` }),
  ];
  if (currentUserId()) {
    reads.push(api("post_saves", { query: `select=post_id&user_id=eq.${currentUserId()}&post_id=in.${encodeURIComponent(idFilter)}` }));
  }
  const [profiles, likes, commentRows, savedRows = []] = await Promise.all(reads);
  const profileMap = new Map((profiles || []).map(profile => [profile.id, profile]));
  const liked = new Set((likes || []).filter(row => row.user_id === currentUserId()).map(row => row.post_id));
  const saved = new Set((savedRows || []).map(row => row.post_id));
  const likeCounts = new Map(), commentCounts = new Map();
  for (const row of likes || []) likeCounts.set(row.post_id, (likeCounts.get(row.post_id) || 0) + 1);
  for (const row of commentRows || []) commentCounts.set(row.post_id, (commentCounts.get(row.post_id) || 0) + 1);
  return posts.map(post => ({
    post, profile: profileMap.get(post.user_id),
    liked: liked.has(post.id), saved: saved.has(post.id),
    likes: currentUserId() ? likeCounts.get(post.id) || 0 : null,
    comments: commentCounts.get(post.id) || 0,
  }));
}

async function renderFeed() {
  const action = currentUserId() ? `<button class="heading-action" data-action="create">＋ Publier</button>` : "";
  const mediaUrlsColumn = state.schemaUpgradeRequired ? "" : ",media_urls";
  $("#main-content").innerHTML = `<span class="eyebrow">MARKETPLACE TUNISIEN</span>${pageHeading("Marketplace TN", "Des trouvailles de partout en Tunisie.", action)}
    <div class="category-row">${categories.map(category => `<button class="category-chip ${category === state.category ? "active" : ""}" data-category="${escapeHTML(category)}">${escapeHTML(category)}</button>`).join("")}</div>
    <div id="feed-list" class="feed-list"><div class="empty-card">On prépare ton fil...</div></div>`;
  renderRail();
  const posts = await api("posts", {
    query: `select=id,user_id,caption,media_url${mediaUrlsColumn},media_type,product_name,price,category,created_at&order=created_at.desc&limit=60`,
  });
  const filtered = (posts || []).filter(post => {
    const categoryMatch = state.category === "Tout" || post.category === state.category;
    const needle = state.search.trim().toLocaleLowerCase();
    const searchMatch = !needle || `${post.caption} ${post.product_name || ""} ${post.category || ""}`.toLocaleLowerCase().includes(needle);
    return categoryMatch && searchMatch;
  });
  const decorated = await decoratePosts(filtered);
  $("#feed-list").innerHTML = decorated.length
    ? decorated.map(item => postCard(item.post, item.profile, item.likes, item.liked, item.saved, item.comments)).join("")
    : emptyHTML("✳", state.search ? "Rien trouvé pour l'instant." : "Le premier post, c'est peut-être le tien.", state.search ? "Essaie un autre mot-clé ou une catégorie." : "Partage une photo ou une vidéo pour lancer le marché.", `<button class="button button-dark" data-action="create">Publier une trouvaille →</button>`);
  observeReels();
}

function observeReels() {
  reelObserver?.disconnect();
  const videos = $$(".post-media.video");
  if (!videos.length) return;
  if (!("IntersectionObserver" in window)) return;
  reelObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const video = entry.target;
      if (entry.isIntersecting) {
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    }
  }, { threshold: 0.65 });
  videos.forEach(video => reelObserver.observe(video));
}

async function renderSaved() {
  const mediaUrlsColumn = state.schemaUpgradeRequired ? "" : ",media_urls";
  $("#main-content").innerHTML = `${pageHeading("Tes favoris.", "Les produits que tu gardes à l'œil.")}<div id="feed-list" class="feed-list"><div class="empty-card">Chargement...</div></div>`;
  $("#right-rail").innerHTML = "";
  const saves = await api("post_saves", { query: `select=post_id&user_id=eq.${currentUserId()}&order=created_at.desc` });
  if (!saves?.length) {
    $("#feed-list").innerHTML = emptyHTML("♡", "Pas encore de favoris.", "Appuie sur le petit signet d'un produit pour le retrouver ici.");
    return;
  }
  const ids = `(${saves.map(row => row.post_id).join(",")})`;
  const posts = await api("posts", { query: `select=id,user_id,caption,media_url${mediaUrlsColumn},media_type,product_name,price,category,created_at&id=in.${encodeURIComponent(ids)}&order=created_at.desc` });
  const decorated = await decoratePosts(posts || []);
  $("#feed-list").innerHTML = decorated.map(item => postCard(item.post, item.profile, item.likes, item.liked, item.saved, item.comments)).join("");
}

async function renderProfile() {
  const mediaUrlsColumn = state.schemaUpgradeRequired ? "" : ",media_urls";
  const pointPriceColumn = state.schemaUpgradeRequired ? "" : ",price_dinar";
  const [posts, saved, requests] = await Promise.all([
    api("posts", { query: `select=id,user_id,caption,media_url${mediaUrlsColumn},media_type,product_name,price,category,created_at&user_id=eq.${currentUserId()}&order=created_at.desc&limit=80` }),
    api("post_saves", { query: `select=post_id&user_id=eq.${currentUserId()}` }),
    api("point_requests", { query: `select=id,amount${pointPriceColumn},provider,status,admin_reason,created_at&user_id=eq.${currentUserId()}&order=created_at.desc&limit=20` }),
  ]);
  $("#right-rail").innerHTML = "";
  $("#main-content").innerHTML = `${pageHeading("Mon profil.", "Ta vitrine Marketplace TN, à ton image.", `<button class="heading-action" data-action="edit-profile">Modifier le profil</button>`)}
    <section class="profile-hero">${avatarHTML(state.profile)}<div><h2>${escapeHTML(state.profile.display_name)}</h2><p>${escapeHTML(state.profile.bio || "Bienvenue sur mon marché ✳")}</p></div></section>
    <div class="stat-grid"><div class="stat-box"><b>${posts?.length || 0}</b><small>publications</small></div><div class="stat-box"><b>${saved?.length || 0}</b><small>favoris</small></div><div class="stat-box"><b>${state.profile.points}</b><small>points dispo.</small></div></div>
    <div class="page-heading"><div><h1>Mes demandes de points</h1></div><button class="heading-action" data-action="points">＋ Ajouter des points</button></div>
    <div class="panel-card" style="padding:12px;margin-bottom:16px">${requests?.length ? requests.map(request => `<div class="request-card"><h3>${request.amount} points · ${escapeHTML(request.provider)} · ${money(Number(request.price_dinar) || request.amount)} <span class="status-pill ${escapeHTML(request.status)}">${request.status === "pending" ? "En attente" : request.status === "approved" ? "Validée" : "Refusée"}</span></h3><p>${new Date(request.created_at).toLocaleString("fr-TN")}${request.admin_reason ? ` · Motif : ${escapeHTML(request.admin_reason)}` : ""}</p></div>`).join("") : `<p class="muted" style="font-size:11px">Aucune demande envoyée pour le moment.</p>`}</div>
    <div class="page-heading"><div><h1>Mes publications</h1></div><button class="heading-action" data-action="create">＋ Publier</button></div>
    <div id="feed-list" class="feed-list"></div>`;
  const decorated = await decoratePosts(posts || []);
  $("#feed-list").innerHTML = decorated.length
    ? decorated.map(item => postCard(item.post, item.profile, item.likes, item.liked, item.saved, item.comments)).join("")
    : emptyHTML("✳", "Ta vitrine est toute neuve.", "Publie ton premier produit et fais-le découvrir.");
}

async function renderMessages() {
  $("#right-rail").innerHTML = "";
  $("#main-content").innerHTML = `${pageHeading("Tes messages.", "Les conversations entre toi et les vendeurs.")}<div id="message-inbox" class="panel-card" style="padding:15px">Chargement...</div>`;
  const attachmentColumns = state.schemaUpgradeRequired ? "" : ",attachment_url,attachment_type";
  const messages = await api("messages", {
    query: `select=id,sender_id,recipient_id,post_id,body${attachmentColumns},created_at&or=(sender_id.eq.${currentUserId()},recipient_id.eq.${currentUserId()})&order=created_at.desc&limit=100`,
  });
  const latest = new Map();
  for (const message of messages || []) {
    const partner = message.sender_id === currentUserId() ? message.recipient_id : message.sender_id;
    if (!latest.has(partner)) latest.set(partner, message);
  }
  if (!latest.size) {
    $("#message-inbox").innerHTML = emptyHTML("▤", "Pas encore de conversation.", "Trouve un produit qui te plaît et écris directement au vendeur.");
    return;
  }
  const ids = `(${[...latest.keys()].join(",")})`;
  const profiles = await api("public_profiles", { query: `select=id,display_name,avatar_url&id=in.${encodeURIComponent(ids)}` });
  const map = new Map((profiles || []).map(profile => [profile.id, profile]));
  $("#message-inbox").innerHTML = `<div class="conversation-list">${[...latest.entries()].map(([id, message]) => {
    const profile = map.get(id);
    return `<button class="inbox-row" data-action="message" data-user="${escapeHTML(id)}">
      ${avatarHTML(profile, "conversation-avatar")}      <span class="conversation-copy"><b>${escapeHTML(profile?.display_name || "Membre Marketplace TN")}</b><small>${escapeHTML(message.body || (message.attachment_type === "audio" ? "🎙 Message vocal" : message.attachment_url ? "📷 Photo" : ""))}</small></span><time>${new Date(message.created_at).toLocaleDateString("fr-TN")}</time><span class="conversation-chevron">›</span></button>`;
  }).join("")}</div>`;
}

async function renderAdmin() {
  if (!state.profile?.is_admin) {
    state.page = "feed";
    await renderPage();
    openAdminAccessHelp();
    return;
  }
  $("#right-rail").innerHTML = "";
  const pointPriceColumn = state.schemaUpgradeRequired ? "" : ",price_dinar";
  $("#main-content").innerHTML = `${pageHeading("Administration.", "Le tableau de bord Marketplace TN.")}<div id="admin-stats" class="admin-stats"><div class="empty-card">Chargement des statistiques...</div></div><div class="admin-tabs"><button data-admin-tab="requests" class="${state.adminTab === "requests" ? "active" : ""}">Demandes de points</button><button data-admin-tab="users" class="${state.adminTab === "users" ? "active" : ""}">Membres</button><button data-admin-tab="settings" class="${state.adminTab === "settings" ? "active" : ""}">Coordonnées de paiement</button></div><div id="admin-list" class="panel-card" style="padding:15px">Chargement...</div>`;
  const [userCount, postCount, videoCount, commentCount, messageCount, pendingCount, approvedCount] = await Promise.all([
    apiCount("profiles"),
    apiCount("posts"),
    apiCount("posts", "media_type=eq.video"),
    apiCount("comments"),
    apiCount("messages"),
    apiCount("point_requests", "status=eq.pending"),
    apiCount("point_requests", "status=eq.approved"),
  ]);
  $("#admin-stats").innerHTML = [
    ["Membres inscrits", userCount, "◉"],
    ["Publications", postCount, "▧"],
    ["Photos publiées", postCount - videoCount, "▣"],
    ["Vidéos publiées", videoCount, "▷"],
    ["Commentaires", commentCount, "♧"],
    ["Messages échangés", messageCount, "▤"],
    ["Paiements en attente", pendingCount, "◷"],
    ["Paiements validés", approvedCount, "✓"],
  ].map(([label, count, icon]) => `<article class="admin-stat"><span>${icon}</span><b>${count.toLocaleString("fr-TN")}</b><small>${label}</small></article>`).join("");
  if (state.adminTab === "requests") {
    const rows = await api("point_requests", { query: `select=id,user_id,amount${pointPriceColumn},provider,destination,receipt_url,note,status,admin_reason,created_at&order=created_at.desc&limit=100` });
    if (!rows?.length) {
      $("#admin-list").innerHTML = emptyHTML("✳", "Aucune demande.", "Les demandes de points s'afficheront ici.");
      return;
    }
    const userIds = `(${[...new Set(rows.map(row => row.user_id))].join(",")})`;
    const users = await api("profiles", { query: `select=id,display_name&id=in.${encodeURIComponent(userIds)}` });
    const userMap = new Map((users || []).map(user => [user.id, user]));
    const receiptURLs = await Promise.all(rows.map(row => signedReceipt(row.receipt_url)));
    $("#admin-list").innerHTML = rows.map((row, index) => `<article class="request-card">
      <h3>${escapeHTML(userMap.get(row.user_id)?.display_name || "Membre")} · ${row.amount} points <span class="status-pill ${escapeHTML(row.status)}">${row.status === "pending" ? "En attente" : row.status === "approved" ? "Validée" : "Refusée"}</span></h3>
      <p><b>${escapeHTML(row.provider)} · ${money(Number(row.price_dinar) || row.amount)} payés</b></p>
      <p>Numéro / identifiant du membre : <b>${escapeHTML(row.destination)}</b> · ${new Date(row.created_at).toLocaleString("fr-TN")}</p>
      ${row.note ? `<p>${escapeHTML(row.note)}</p>` : ""}
      <img src="${escapeHTML(safeURL(receiptURLs[index]))}" alt="Justificatif privé de paiement">
      ${row.status === "pending" ? `<div class="request-actions"><button class="approve" data-action="approve-request" data-request="${escapeHTML(row.id)}">Accepter + ajouter les points</button><button class="reject" data-action="reject-request" data-request="${escapeHTML(row.id)}">Refuser</button></div>`       : `<p>${row.admin_reason ? `Motif : ${escapeHTML(row.admin_reason)}` : "Demande traitée."}</p>`}
      </article>`).join("");
  } else if (state.adminTab === "users") {
    const rows = await api("profiles", { query: "select=id,email,display_name,bio,points,is_banned,created_at&order=created_at.desc&limit=200" });
    $("#admin-list").innerHTML = rows?.length ? rows.map(user => `<article class="user-card"><h3>${escapeHTML(user.display_name)} ${user.is_banned ? '<span class="status-pill rejected">Suspendu</span>' : ""}</h3>
      <p>${escapeHTML(user.email)} · ${user.points} points · inscrit le ${new Date(user.created_at).toLocaleDateString("fr-TN")}</p>
      <div class="user-actions"><button class="button-light" data-action="admin-points" data-user="${escapeHTML(user.id)}" data-name="${escapeHTML(user.display_name)}">Ajuster les points</button><button class="${user.is_banned ? "approve" : "reject"}" data-action="admin-ban" data-user="${escapeHTML(user.id)}" data-ban="${!user.is_banned}">${user.is_banned ? "Réactiver" : "Suspendre"}</button></div></article>`).join("") : emptyHTML("◉", "Aucun membre.", "Les comptes créés apparaîtront ici.");
  } else {
    const settings = await api("app_settings", { query: "select=d17,ooredoo,flouci&id=eq.1&limit=1" });
    const values = settings?.[0] || {};
    $("#admin-list").innerHTML = `<div class="panel-card" style="border:0;box-shadow:none;padding:2px"><h3>Coordonnées de paiement à afficher aux acheteurs</h3><p class="muted" style="font-size:11px;line-height:1.6">Ces coordonnées sont partagées avec tous les membres dans la fenêtre « Ajouter des points ».</p><label class="field">Numéro D17<input id="payment-d17" maxlength="80" placeholder="90272020" value="${escapeHTML(values.d17 || "90272020")}"></label><label class="field">Numéro Ooredoo<input id="payment-ooredoo" maxlength="80" placeholder="90576380" value="${escapeHTML(values.ooredoo || "90576380")}"></label><label class="field">Identifiant Flouci<input id="payment-flouci" maxlength="80" placeholder="Identifiant ou numéro" value="${escapeHTML(values.flouci || "")}"></label><button class="button button-dark" data-action="save-payment-settings">Enregistrer les coordonnées</button></div>`;
  }
}

async function renderPage() {
  updateNavigation();
  try {
    if (state.page === "saved") await renderSaved();
    else if (state.page === "profile") await renderProfile();
    else if (state.page === "messages") await renderMessages();
    else if (state.page === "admin") await renderAdmin();
    else {
      state.page = "feed";
      await renderFeed();
      updateNavigation();
    }
  } catch (error) {
    if (/JWT|token|session/i.test(error.message)) {
      await signOut();
      $("#auth-error").textContent = "Ta session a expiré. Reconnecte-toi.";
      return;
    }
    const title = state.page === "admin" ? "Le tableau de bord n'a pas pu s'ouvrir." : "Impossible de charger cette page.";
    $("#main-content").innerHTML = emptyHTML("!", title, error.message, `<button class="button button-light" data-action="retry">Réessayer</button>`);
  }
  if (state.schemaUpgradeRequired) $("#main-content").insertAdjacentHTML("afterbegin", schemaUpgradeNotice());
}

function openModal(title, content) {
  discardMessageRecording();
  $("#modal-root").innerHTML = `<div class="modal-backdrop" data-action="backdrop"><section class="modal" role="dialog" aria-modal="true" aria-label="${escapeHTML(title)}"><div class="modal-head"><h2>${escapeHTML(title)}</h2><button class="modal-close" data-action="close-modal" aria-label="Fermer">×</button></div>${content}</section></div>`;
}

function updateImageViewer() {
  const image = $("#image-viewer-image");
  if (!image) return;
  image.style.transform = `translate(${imageViewerOffset.x}px, ${imageViewerOffset.y}px) scale(${imageViewerScale})`;
  $("#image-viewer-level").textContent = `${Math.round(imageViewerScale * 100)}%`;
}

function openImageViewer(source, alt) {
  imageViewerScale = 1;
  imageViewerOffset = { x: 0, y: 0 };
  $("#modal-root").innerHTML = `<div class="image-viewer-backdrop" data-action="close-modal"><div class="image-viewer-toolbar"><button data-action="close-modal" aria-label="Fermer">×</button><button data-viewer-zoom="-0.5" aria-label="Dézoomer">−</button><span id="image-viewer-level">100%</span><button data-viewer-zoom="0.5" aria-label="Zoomer">+</button><button data-viewer-zoom="reset">Réinitialiser</button></div><img id="image-viewer-image" src="${escapeHTML(safeURL(source))}" alt="${escapeHTML(alt)}" draggable="false"></div>`;
  const backdrop = $(".image-viewer-backdrop");
  const image = $("#image-viewer-image");
  let drag = null;
  image.addEventListener("click", event => event.stopPropagation());
  image.addEventListener("pointerdown", event => {
    if (imageViewerScale <= 1) return;
    drag = { x: event.clientX, y: event.clientY, offsetX: imageViewerOffset.x, offsetY: imageViewerOffset.y };
    image.setPointerCapture(event.pointerId);
  });
  image.addEventListener("pointermove", event => {
    if (!drag) return;
    imageViewerOffset = {
      x: drag.offsetX + event.clientX - drag.x,
      y: drag.offsetY + event.clientY - drag.y,
    };
    updateImageViewer();
  });
  image.addEventListener("pointerup", () => { drag = null; });
  backdrop.addEventListener("wheel", event => {
    event.preventDefault();
    imageViewerScale = Math.min(5, Math.max(1, imageViewerScale + (event.deltaY < 0 ? 0.25 : -0.25)));
    if (imageViewerScale === 1) imageViewerOffset = { x: 0, y: 0 };
    updateImageViewer();
  }, { passive: false });
}

function openCreateModal() {
  if ((state.profile?.points || 0) < 1) {
    toast("Pas assez de points pour publier. Recharge ton solde.", true);
    openPointsModal();
    return;
  }
  openModal("Partager une trouvaille.", `<form id="create-form">
    <label class="field">Photos (jusqu'à 6) ou une vidéo *<span class="upload-zone"><strong>＋ Choisis tes fichiers</strong><span>1 à 6 photos (20 Mo chacune), ou une vidéo MP4/WebM/MOV (100 Mo max)</span><input id="post-file" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime" multiple required><span id="post-preview-list" class="post-preview-list"></span></span></label>
    <p id="upload-cost" class="inline-note">Photo : 1 point · Vidéo : 2 points · Solde : ${state.profile.points} points</p>
    <div id="upload-progress" class="upload-progress hidden" role="status"><span>Préparation de l'envoi...</span><progress max="100" value="0"></progress><b>0%</b></div>
    <label class="field">Une petite légende<textarea name="caption" maxlength="2000" placeholder="Raconte-nous ce qui rend cette trouvaille spéciale..."></textarea></label>
    <label class="field">Nom du produit<input name="product_name" maxlength="100" placeholder="Ex. Sac en cuir fait main"></label>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><label class="field">Prix (DT)<input name="price" type="number" min="0" step="0.001" placeholder="Prix facultatif"></label><label class="field">Catégorie<select name="category">${categories.filter(item => item !== "Tout").map(item => `<option>${escapeHTML(item)}</option>`).join("")}</select></label></div>
    <p id="modal-error" class="form-error"></p><div class="modal-actions"><button class="button button-light" type="button" data-action="close-modal">Annuler</button><button class="button button-dark" type="submit">Publier ✦</button></div>
  </form>`);
}

async function openPointsModal() {
  const rows = await api("app_settings", { query: "select=d17,ooredoo,flouci&id=eq.1&limit=1" });
  const settings = rows?.[0] || {};
  const numbers = {
    D17: settings.d17 || "90272020",
    Ooredoo: settings.ooredoo || "90576380",
    Flouci: settings.flouci || "À confirmer par l'équipe",
  };
  const flouciAvailable = Boolean(settings.flouci?.trim());
  openModal("Acheter des points.", `<div class="payment-steps"><span class="active">1 · Choisir</span><i></i><span>2 · Payer</span><i></i><span>3 · Envoyer la preuve</span></div><p class="payment-intro">Choisis ton pack, paie le montant indiqué au numéro Marketplace TN ci-dessous, puis envoie la capture. L'équipe vérifie le transfert avant d'ajouter les points.</p>
    <form id="points-form">
      <label class="field">Choisis ton offre<select name="package" required>${pointPackages.map((offer, index) => `<option value="${index}">${escapeHTML(offer.label)} · ${offer.price} DT — ${escapeHTML(offer.detail)}</option>`).join("")}</select></label>
      <div id="package-summary" class="package-summary">${escapeHTML(pointPackages[0].detail)} · À payer : ${pointPackages[0].price} DT</div>
      <label class="field">Points demandés<input name="amount" type="number" min="1" max="100000" readonly required value="${pointPackages[0].points}"></label>
      <label class="field">Moyen de paiement<select name="provider" required><option value="D17">D17</option><option value="Ooredoo">Ooredoo</option><option value="Flouci" ${flouciAvailable ? "" : "disabled"}>Flouci${flouciAvailable ? "" : " · à configurer"}</option></select></label>
      <div class="payment-destination-card"><small>ENVOYER LE PAIEMENT À</small><strong id="payment-destination">${escapeHTML(numbers.D17)}</strong><span id="payment-destination-label">Coordonnée D17 Marketplace TN</span></div>
      <label class="field">Ton numéro / identifiant utilisé pour payer<input name="destination" required maxlength="80" placeholder="+216 ..."></label>
      <label class="field">Preuve du paiement *<span class="upload-zone"><strong>＋ Ajouter une capture du reçu</strong><span>JPG, PNG ou WebP · privée, visible seulement par toi et l'admin</span><input id="receipt-file" type="file" accept="image/jpeg,image/png,image/webp" required><img class="upload-preview hidden" id="receipt-preview" alt="Aperçu du reçu"></span></label>
      <label class="field">Note (facultatif)<textarea name="note" maxlength="500" placeholder="Référence du transfert..."></textarea></label>
      <div id="upload-progress" class="upload-progress hidden" role="status"><span>Préparation de l'envoi...</span><progress max="100" value="0"></progress><b>0%</b></div>
      <p id="modal-error" class="form-error"></p><div class="modal-actions"><button class="button button-light" type="button" data-action="close-modal">Annuler</button><button class="button button-dark" type="submit">Envoyer au tableau admin →</button></div>
    </form>`);
  $("#points-form").dataset.numbers = JSON.stringify(numbers);
}

async function openComments(postId) {
  const commentComposer = currentUserId()
    ? `<form id="comment-form" class="inline-form"><input name="body" maxlength="1000" required placeholder="Écris un commentaire..."><button type="submit">Envoyer</button></form>`
    : `<button class="button button-dark full" type="button" data-action="require-auth">Connecte-toi pour commenter</button>`;
  openModal("Les commentaires.", `<div class="comment-list">Chargement...</div>${commentComposer}<p id="modal-error" class="form-error"></p>`);
  if (currentUserId()) $("#comment-form").dataset.post = postId;
  const comments = await api("comments", { query: `select=id,user_id,body,created_at&post_id=eq.${postId}&order=created_at.asc&limit=100` });
  const ids = `(${[...new Set((comments || []).map(comment => comment.user_id))].join(",") || currentUserId()})`;
  const profiles = comments?.length
    ? await api("public_profiles", { query: `select=id,display_name&id=in.${encodeURIComponent(ids)}` })
    : [];
  const map = new Map((profiles || []).map(profile => [profile.id, profile]));
  $(".comment-list").innerHTML = comments?.length
    ? comments.map(comment => `<div class="comment-row"><b>${escapeHTML(map.get(comment.user_id)?.display_name || "Membre")}</b>${escapeHTML(comment.body)}</div>`).join("")
    : `<p class="muted" style="font-size:11px">Sois le premier à commenter ✳</p>`;
}

async function openMessages(recipientId, postId = "") {
  const profileRows = await api("public_profiles", { query: `select=id,display_name,avatar_url&id=eq.${recipientId}&limit=1` });
  const recipient = profileRows?.[0];
  if (!recipient) throw new Error("Ce profil n'est plus disponible.");
  discardMessageRecording();
  openModal(`Message à ${recipient.display_name}.`, `<header class="conversation-header">${avatarHTML(recipient, "conversation-avatar")}<span><b>${escapeHTML(recipient.display_name)}</b><small>Conversation privée</small></span></header><div class="message-list">Chargement...</div><form id="message-form"><div class="message-composer"><input name="body" maxlength="2000" placeholder="Ton message privé..."><div class="message-tools"><label class="message-attach" title="Joindre une photo ou un audio">＋ Joindre<input id="message-attachment" type="file" accept="image/jpeg,image/png,image/webp,audio/webm,audio/ogg,audio/mp4,audio/mpeg,audio/wav,audio/x-m4a"></label><button class="message-record" type="button" data-action="record-message">🎙 Enregistrer un vocal</button><button type="submit">Envoyer</button></div><small id="message-attachment-name" class="muted"></small></div></form><p id="modal-error" class="form-error"></p>`);
  $(".modal").classList.add("conversation-modal");
  $("#message-form").dataset.user = recipientId;
  $("#message-form").dataset.post = postId;
  const attachmentColumns = state.schemaUpgradeRequired ? "" : ",attachment_url,attachment_type";
  const query = `select=id,sender_id,recipient_id,post_id,body${attachmentColumns},created_at&or=(and(sender_id.eq.${currentUserId()},recipient_id.eq.${recipientId}),and(sender_id.eq.${recipientId},recipient_id.eq.${currentUserId()}))&order=created_at.asc&limit=100`;
  const messages = await api("messages", { query });
  const attachmentURLs = await Promise.all((messages || []).map(message => message.attachment_url
    ? signedPrivateObject("marketplace-message-media", message.attachment_url)
    : Promise.resolve("")));
  $(".message-list").innerHTML = messages?.length
    ? messages.map((message, index) => {
      const attachment = attachmentURLs[index]
        ? message.attachment_type === "audio"
          ? `<audio class="message-audio" controls preload="metadata" src="${escapeHTML(safeURL(attachmentURLs[index]))}"></audio>`
          : `<img class="message-image" src="${escapeHTML(safeURL(attachmentURLs[index]))}" alt="Photo privée envoyée dans cette conversation" loading="lazy">`
        : "";
      return `<div class="message-row ${message.sender_id === currentUserId() ? "mine" : "theirs"}"><b>${message.sender_id === currentUserId() ? "Toi" : escapeHTML(recipient.display_name)}</b>${message.body ? `<span>${escapeHTML(message.body)}</span>` : ""}${attachment}<small>${new Date(message.created_at).toLocaleString("fr-TN", { dateStyle: "short", timeStyle: "short" })}</small></div>`;
    }).join("")
    : `<p class="muted" style="font-size:11px">Démarre la conversation en parlant du produit qui t'intéresse ✳</p>`;
  $(".message-list").scrollTop = $(".message-list").scrollHeight;
}

function discardMessageRecording() {
  if (messageRecorder?.state === "recording") messageRecorder.stop();
  messageRecorder = null;
  messageRecorderChunks = [];
  messageRecorderStream?.getTracks().forEach(track => track.stop());
  messageRecorderStream = null;
  recordedMessageFile = null;
}

async function toggleMessageRecording(button) {
  if (messageRecorder?.state === "recording") {
    messageRecorder.stop();
    button.textContent = "🎙 Enregistrer un vocal";
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    throw new Error("L'enregistrement vocal n'est pas disponible dans ce navigateur.");
  }
  messageRecorderStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"]
    .find(type => MediaRecorder.isTypeSupported(type));
  messageRecorder = new MediaRecorder(messageRecorderStream, mimeType ? { mimeType } : undefined);
  const recorder = messageRecorder;
  const form = $("#message-form");
  messageRecorderChunks = [];
  messageRecorder.addEventListener("dataavailable", event => {
    if (event.data.size) messageRecorderChunks.push(event.data);
  });
  messageRecorder.addEventListener("stop", () => {
    const type = recorder.mimeType || "audio/webm";
    const extension = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm";
    const blob = new Blob(messageRecorderChunks, { type });
    if (form.isConnected && blob.size) {
      recordedMessageFile = new File([blob], `vocal.${extension}`, { type });
    }
    const label = $("#message-attachment-name");
    if (label) label.textContent = "Message vocal prêt à être envoyé.";
    messageRecorderStream?.getTracks().forEach(track => track.stop());
    messageRecorderStream = null;
  }, { once: true });
  messageRecorder.start();
  button.textContent = "■ Arrêter l'enregistrement";
  $("#message-attachment-name").textContent = "Enregistrement en cours…";
}

function openPostMenu(postId, ownerId) {
  if (ownerId !== currentUserId() && !state.profile?.is_admin) {
    toast("Seul le propriétaire ou l'administration peut modifier cette publication.", true);
    return;
  }
  openModal("Gérer la publication.", `<div class="post-menu-actions"><button class="button button-light" data-action="edit-post" data-post="${escapeHTML(postId)}">Modifier les détails</button><button class="button button-danger" data-action="delete-post" data-post="${escapeHTML(postId)}">Supprimer la publication</button></div>`);
}

async function openEditPost(postId) {
  const rows = await api("posts", { query: `select=id,user_id,caption,product_name,price,category&id=eq.${postId}&limit=1` });
  const post = rows?.[0];
  if (!post || (post.user_id !== currentUserId() && !state.profile?.is_admin)) {
    throw new Error("Publication introuvable ou accès refusé.");
  }
  openModal("Modifier la publication.", `<form id="edit-post-form" data-post="${escapeHTML(post.id)}">
    <label class="field">Légende<textarea name="caption" maxlength="2000">${escapeHTML(post.caption || "")}</textarea></label>
    <label class="field">Nom du produit<input name="product_name" maxlength="100" value="${escapeHTML(post.product_name || "")}"></label>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><label class="field">Prix (DT)<input name="price" type="number" min="0" step="0.001" value="${post.price === null ? "" : escapeHTML(post.price)}"></label><label class="field">Catégorie<select name="category">${categories.filter(item => item !== "Tout").map(item => `<option ${item === post.category ? "selected" : ""}>${escapeHTML(item)}</option>`).join("")}</select></label></div>
    <p id="modal-error" class="form-error"></p><div class="modal-actions"><button type="button" class="button button-light" data-action="close-modal">Annuler</button><button class="button button-dark" type="submit">Enregistrer</button></div>
  </form>`);
}

function openEditProfile() {
  const avatarPreview = state.profile.avatar_url
    ? `<img id="avatar-preview" class="upload-preview" src="${escapeHTML(safeURL(mediaURL(state.profile.avatar_url)))}" alt="Photo de profil">`
    : `<img id="avatar-preview" class="upload-preview hidden" alt="Aperçu de la photo">`;
  openModal("Ton profil.", `<form id="profile-form"><label class="field">Photo de profil<span class="upload-zone"><strong>＋ Choisir une photo</strong><span>JPG, PNG ou WebP · 10 Mo max</span><input id="avatar-file" type="file" accept="image/jpeg,image/png,image/webp">${avatarPreview}</span></label><label class="field">Ton nom<input name="display_name" maxlength="60" required value="${escapeHTML(state.profile.display_name)}"></label><label class="field">Ta bio<textarea name="bio" maxlength="300" placeholder="Quelques mots sur toi...">${escapeHTML(state.profile.bio || "")}</textarea></label><p id="modal-error" class="form-error"></p><div class="modal-actions"><button type="button" class="button button-light" data-action="close-modal">Annuler</button><button class="button button-dark">Enregistrer</button></div></form>`);
}

async function handleModalSubmit(event) {
  const form = event.target;
  if (!form.closest("#modal-root")) return;
  event.preventDefault();
  const data = new FormData(form);
  const errorEl = $("#modal-error", form.closest(".modal"));
  const submit = $('button[type="submit"], button:not([type])', form);
  if (submit) submit.disabled = true;
  try {
    if (form.id === "create-form") {
      const files = [...$("#post-file").files];
      if (!files.length) throw new Error("Choisis une ou plusieurs photos, ou une vidéo.");
      const isVideo = files[0].type.startsWith("video/");
      if (isVideo && files.length !== 1) throw new Error("Une vidéo se publie seule. Pour plusieurs fichiers, choisis uniquement des photos.");
      if (files.some(file => file.type.startsWith("video/") !== isVideo)) throw new Error("Ne mélange pas photos et vidéos dans une publication.");
      if (!isVideo && files.length > 6) throw new Error("Tu peux ajouter au maximum 6 photos par publication.");
      const allowedImages = new Set(["image/jpeg", "image/png", "image/webp"]);
      const allowedVideos = new Set(["video/mp4", "video/webm", "video/quicktime"]);
      if (files.some(file => !(isVideo ? allowedVideos : allowedImages).has(file.type.split(";")[0].toLowerCase()))) {
        throw new Error("Format refusé. Utilise JPG, PNG, WebP, MP4, WebM ou MOV.");
      }
      const maxFileSize = isVideo ? 100 * 1024 * 1024 : 20 * 1024 * 1024;
      if (files.some(file => file.size > maxFileSize)) {
        throw new Error(`Chaque fichier ne peut pas dépasser ${isVideo ? 100 : 20} Mo.`);
      }
      const cost = isVideo ? 2 : files.length;
      if (state.profile.points < cost) throw new Error(`Il te faut ${cost} points pour publier ${isVideo ? "cette vidéo" : `ces ${files.length} photo${files.length > 1 ? "s" : ""}`}.`);
      if (state.schemaUpgradeRequired && !isVideo && files.length > 1) {
        throw new Error("Pour publier plusieurs photos, exécute d'abord la mise à jour SQL depuis le lien affiché en haut de la page.");
      }
      const mediaURLs = await uploadMany(files, "marketplace-media", percent => updateUploadProgress(percent, `Envoi des fichiers… ${percent}%`));
      updateUploadProgress(100, "Enregistrement de la publication...");
      const result = await rpc(isVideo || state.schemaUpgradeRequired ? "create_post" : "create_photo_post", isVideo || state.schemaUpgradeRequired ? {
          p_caption: data.get("caption") || "",
          p_media_url: mediaURLs[0],
          p_media_type: isVideo ? "video" : "image",
          p_product_name: data.get("product_name") || null,
          p_price: data.get("price") ? Number(data.get("price")) : null,
          p_category: data.get("category") || "Autre",
        } : {
          p_caption: data.get("caption") || "",
          p_media_urls: mediaURLs,
          p_product_name: data.get("product_name") || null,
          p_price: data.get("price") ? Number(data.get("price")) : null,
          p_category: data.get("category") || "Autre",
        });
      state.profile.points -= cost;
      $("#points-balance").textContent = state.profile.points;
      $("#modal-root").innerHTML = "";
      toast(`Publication partagée ! −${cost} point${cost > 1 ? "s" : ""} ✦`);
      state.page = "feed";
      await renderPage();
      return result;
    }
    if (form.id === "points-form") {
      const file = $("#receipt-file").files?.[0];
      if (!file) throw new Error("Ajoute une capture de ton reçu.");
      const offer = pointPackages[Number(data.get("package"))];
      if (!offer) throw new Error("Choisis une offre de recharge valide.");
      const receiptURL = await upload(file, "marketplace-receipts", percent => updateUploadProgress(percent));
      updateUploadProgress(100, "Envoi de la preuve à l'équipe...");
      await rpc("create_point_request", {
        p_amount: offer.points,
        ...(state.schemaUpgradeRequired ? {} : { p_price_dinar: offer.price }),
        p_provider: data.get("provider"),
        p_destination: data.get("destination"),
        p_receipt_url: receiptURL,
        p_note: data.get("note") || "",
      });
      $("#modal-root").innerHTML = "";
      toast("Demande envoyée. Tu recevras les points après vérification.");
      return;
    }
    if (form.id === "comment-form") {
      await rpc("create_comment", { p_post_id: form.dataset.post, p_body: data.get("body") });
      await openComments(form.dataset.post);
      return;
    }
    if (form.id === "message-form") {
      const body = String(data.get("body") || "").trim();
      if (messageRecorder?.state === "recording") throw new Error("Arrête l'enregistrement vocal avant d'envoyer.");
      const attachment = $("#message-attachment").files?.[0] || recordedMessageFile;
      if (state.schemaUpgradeRequired && attachment) {
        throw new Error("Exécute d'abord la mise à jour SQL pour envoyer les photos et vocaux privés.");
      }
      if (!body && !attachment) throw new Error("Écris un message, joins une photo ou enregistre un vocal.");
      let attachmentURL = null;
      let attachmentType = null;
      if (attachment) {
        attachmentType = attachment.type.startsWith("audio/") ? "audio" : "image";
        attachmentURL = await upload(attachment, "marketplace-message-media", percent => updateUploadProgress(percent));
      }
      await rpc("send_private_message", {
        p_recipient_id: form.dataset.user, p_body: body,
        p_post_id: form.dataset.post || null,
        ...(state.schemaUpgradeRequired ? {} : {
          p_attachment_url: attachmentURL,
          p_attachment_type: attachmentType,
        }),
      });
      discardMessageRecording();
      await openMessages(form.dataset.user, form.dataset.post);
      return;
    }
    if (form.id === "edit-post-form") {
      await rpc("update_post", {
        p_post_id: form.dataset.post,
        p_caption: data.get("caption") || "",
        p_product_name: data.get("product_name") || "",
        p_price: data.get("price") ? Number(data.get("price")) : null,
        p_category: data.get("category") || "Autre",
      });
      $("#modal-root").innerHTML = "";
      toast("Publication modifiée.");
      await renderPage();
      return;
    }
    if (form.id === "profile-form") {
      const avatar = $("#avatar-file").files?.[0];
      if (avatar && !avatar.type.startsWith("image/")) throw new Error("La photo de profil doit être une image.");
      if (avatar && avatar.size > 10 * 1024 * 1024) throw new Error("La photo de profil doit faire moins de 10 Mo.");
      const changes = { display_name: data.get("display_name"), bio: data.get("bio") || "" };
      if (avatar) changes.avatar_url = await upload(avatar);
      await api("profiles", {
        method: "PATCH",
        query: `id=eq.${currentUserId()}`,
        body: changes,
      });
      state.profile.display_name = data.get("display_name");
      state.profile.bio = data.get("bio") || "";
      if (changes.avatar_url) state.profile.avatar_url = changes.avatar_url;
      $("#modal-root").innerHTML = "";
      $("#avatar-button").textContent = initials(state.profile.display_name);
      toast("Profil mis à jour.");
      await renderPage();
      return;
    }
  } catch (error) {
    if (errorEl) errorEl.textContent = error.message;
    else toast(error.message, true);
  } finally {
    if (submit) submit.disabled = false;
  }
}

$("#auth-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const button = $("#auth-submit");
  const email = String(data.get("email") || "");
  const password = String(data.get("password") || "");
  if (state.authMode === "signup" && !updatePasswordRules()) {
    $("#auth-error").textContent = "كلمة السر يلزمها 8 حروف على الأقل، حرف كبير، حرف صغير، رقم ورمز.";
    return;
  }
  const remaining = state.authMode === "signup" ? signupCooldownRemaining(email) : 0;
  if (remaining > 0) {
    $("#auth-error").textContent = `Limite d'envoi d'e-mails atteinte. Attends ${remaining} secondes avant de réessayer.`;
    refreshSignupButton();
    return;
  }
  button.disabled = true;
  $("#auth-error").textContent = "";
  try {
    if (!state.config) throw new Error("La configuration Supabase est indisponible. Vérifie les variables dans .env.");
    if (!state.setupReady) throw new Error("Installe d'abord le script SQL Marketplace TN dans Supabase.");
    if (state.authMode === "signup") {
      authRequest.pending = true;
      const result = await authRequest("signup", {
        email, password,
        data: { display_name: data.get("display_name") || "Membre" },
      });
      if (result.user?.identities?.length === 0) {
        state.authMode = "login";
        authModeChanged($('[data-auth-mode="login"]'));
        $('input[name="email"]').value = email;
        showAuthError("هذا البريد مسجّل من قبل. ادخل من Connexion، أو استعمل Google كان هذا الحساب مربوط بـGoogle.", { offerLogin: true });
        return;
      }
      authRequest.pending = false;
      if (!result.access_token) {
        $("#auth-error").textContent = "Compte créé ! Confirme ton adresse e-mail, puis connecte-toi.";
        return;
      }
      result.expires_at = Math.floor(Date.now() / 1000) + (result.expires_in || 3600);
      localStorage.setItem("souqna-session", JSON.stringify(result));
      state.session = result;
    } else {
      const result = await authRequest("token?grant_type=password", {
        email, password,
      });
      result.expires_at = Math.floor(Date.now() / 1000) + (result.expires_in || 3600);
      localStorage.setItem("souqna-session", JSON.stringify(result));
      state.session = result;
    }
    await loadProfile();
    await renderPage();
  } catch (error) {
    authRequest.pending = false;
    const isRateLimited = error.status === 429;
    const isEmailRateLimited = state.authMode === "signup" && isRateLimited;
    if (isEmailRateLimited) {
      const secondsFromMessage = Number(error.message.match(/(?:after|in)\s+(\d+)\s*(?:seconds?|s)\b/i)?.[1] || 0);
      const seconds = error.retryAfter || secondsFromMessage || 60;
      startSignupCooldown(email, seconds);
      showAuthError(`استنّى ${seconds} ثانية قبل ما تعاود. Supabase يحدّ من إيميلات التأكيد. للتجربة عطّل تأكيد البريد مؤقتًا من Supabase → Authentication → Sign In / Providers → Email؛ وللموقع الحقيقي اضبط SMTP خاص في Authentication → SMTP Settings.`);
    } else if (state.authMode === "signup" && isExistingAccountError(error)) {
      state.authMode = "login";
      authModeChanged($('[data-auth-mode="login"]'));
      $('input[name="email"]').value = email;
      showAuthError("هذا البريد مسجّل من قبل. ادخل من Connexion، أو استعمل Google كان هذا الحساب مربوط بـGoogle.", { offerLogin: true });
    } else if (isRateLimited) {
      showAuthError("برشا محاولات في وقت قصير. استنّى دقيقة وعاود جرّب.");
      startAuthCooldown(60);
    } else if (/redirect_uri_mismatch/i.test(error.message)) {
      showAuthError("إعداد Google ناقص: أضف https://pufekqipizaqdxtbwcrl.supabase.co/auth/v1/callback في Google Cloud → OAuth client → Authorized redirect URIs.");
    } else {
      showAuthError(error.message);
    }
  } finally {
    authRequest.pending = false;
    refreshSignupButton();
  }
});

$("#guest-continue").addEventListener("click", () => {
  state.guestMode = true;
  $("#auth-error").textContent = "";
  setAuthScreen(false);
  state.page = "feed";
  renderPage();
});

$$("[data-auth-mode]").forEach(button => button.addEventListener("click", () => authModeChanged(button)));

$('input[name="email"]').addEventListener("input", refreshSignupButton);
$('input[name="password"]').addEventListener("input", updatePasswordRules);
$("#password-toggle").addEventListener("click", event => {
  const input = $('input[name="password"]');
  const showing = input.type === "password";
  input.type = showing ? "text" : "password";
  event.currentTarget.textContent = showing ? "Masquer" : "Afficher";
  event.currentTarget.setAttribute("aria-label", showing ? "Masquer le mot de passe" : "Afficher le mot de passe");
});
$("#google-signin").addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  $("#auth-error").textContent = "";
  try {
    await signInWithGoogle();
  } catch (error) {
    button.disabled = false;
    $("#auth-error").textContent = error.message;
  }
});

document.addEventListener("scroll", event => {
  if (event.target instanceof Element && event.target.matches(".post-gallery-track")) {
    updateGalleryPosition(event.target);
  }
}, true);

window.addEventListener("resize", () => {
  $$(".post-gallery-track").forEach(updateGalleryPosition);
});

document.addEventListener("click", async event => {
  const button = event.target.closest("[data-action], [data-page], [data-category], [data-admin-tab], [data-viewer-zoom]");
  if (!button) return;
  try {
    if (button.dataset.viewerZoom) {
      if (button.dataset.viewerZoom === "reset") {
        imageViewerScale = 1;
        imageViewerOffset = { x: 0, y: 0 };
      } else {
        imageViewerScale = Math.min(5, Math.max(1, imageViewerScale + Number(button.dataset.viewerZoom)));
        if (imageViewerScale === 1) imageViewerOffset = { x: 0, y: 0 };
      }
      updateImageViewer();
    } else if (button.dataset.page) {
      if (!currentUserId() && button.dataset.page !== "feed") {
        requireSignIn();
        return;
      }
      state.page = button.dataset.page;
      await renderPage();
    } else if (button.dataset.category) {
      state.category = button.dataset.category;
      await renderFeed();
    } else if (button.dataset.adminTab) {
      state.adminTab = button.dataset.adminTab;
      await renderAdmin();
    } else {
      const { action } = button.dataset;
      if (!currentUserId() && !button.dataset.viewerZoom && !["comments", "zoom-image", "gallery-next", "gallery-previous", "require-auth", "close-modal", "backdrop", "retry"].includes(action)) {
        requireSignIn();
        return;
      }
      if (action === "create") openCreateModal();
      else if (action === "copy-admin-sql") {
        await navigator.clipboard.writeText($("#admin-access-sql").value);
        $("#admin-access-status").textContent = "Requête copiée. Colle-la dans le SQL Editor de ton projet Supabase.";
      } else if (action === "refresh-admin-role") await refreshAdminRole();
      else if (action === "require-auth") requireSignIn();
      else if (action === "points") openPointsModal();
      else if (action === "logout") await signOut();
      else if (action === "close-modal" || (action === "backdrop" && event.target === button)) {
        discardMessageRecording();
        $("#modal-root").innerHTML = "";
      }
      else if (action === "edit-profile") openEditProfile();
      else if (action === "retry") await renderPage();
      else if (action === "comments") await openComments(button.dataset.post);
      else if (action === "message") await openMessages(button.dataset.user, button.dataset.post || "");
      else if (action === "like") {
        await rpc("toggle_like", { p_post_id: button.dataset.post });
        await renderPage();
      } else if (action === "save") {
        await rpc("toggle_save", { p_post_id: button.dataset.post });
        await renderPage();
        toast("Favoris mis à jour.");
      } else if (action === "post-menu") {
        const post = button.closest(".post-card");
        openPostMenu(button.dataset.post, post?.dataset.ownerId);
      } else if (action === "edit-post") {
        await openEditPost(button.dataset.post);
      } else if (action === "delete-post") {
        if (!window.confirm("Supprimer définitivement cette publication ?")) return;
        await api("posts", { method: "DELETE", query: `id=eq.${button.dataset.post}` });
        $("#modal-root").innerHTML = "";
        toast("Publication supprimée.");
        await renderPage();
      } else if (action === "record-message") {
        await toggleMessageRecording(button);
      } else if (action === "zoom-image") {
        openImageViewer(button.dataset.image, button.dataset.alt || "Photo du produit");
      } else if (action === "gallery-next" || action === "gallery-previous") {
        const track = button.closest(".post-gallery")?.querySelector(".post-gallery-track");
        if (track) track.scrollBy({
          left: (action === "gallery-next" ? 1 : -1) * track.clientWidth,
          behavior: "smooth",
        });
      } else if (action === "approve-request") {
        await rpc("admin_review_point_request", { p_request_id: button.dataset.request, p_approve: true, p_reason: "Validée par l'administration." });
        toast("Demande acceptée et points ajoutés.");
        await renderAdmin();
      } else if (action === "reject-request") {
        const reason = window.prompt("Pourquoi refuses-tu cette demande ? Cette raison sera visible par le membre.");
        if (reason === null) return;
        if (!reason.trim()) throw new Error("Ajoute une raison pour refuser la demande.");
        await rpc("admin_review_point_request", { p_request_id: button.dataset.request, p_approve: false, p_reason: reason.trim() });
        toast("Demande refusée. Le membre verra la raison.");
        await renderAdmin();
      } else if (action === "admin-points") {
        const input = window.prompt(`Ajustement des points pour ${button.dataset.name}. Utilise un nombre positif ou négatif.`, "1");
        if (input === null) return;
        const delta = Number(input);
        if (!Number.isInteger(delta) || Math.abs(delta) > 100000) throw new Error("Entre un nombre entier valide.");
        await rpc("admin_update_user", { p_user_id: button.dataset.user, p_points_delta: delta });
        toast("Solde mis à jour.");
        await renderAdmin();
      } else if (action === "admin-ban") {
        const isBanned = button.dataset.ban === "true";
        const confirmText = isBanned ? "Suspendre ce compte ?" : "Réactiver ce compte ?";
        if (!window.confirm(confirmText)) return;
        await rpc("admin_update_user", { p_user_id: button.dataset.user, p_points_delta: 0, p_is_banned: isBanned });
        toast(isBanned ? "Compte suspendu." : "Compte réactivé.");
        await renderAdmin();
      } else if (action === "save-payment-settings") {
        await rpc("admin_update_payment_settings", {
          p_d17: $("#payment-d17").value.trim(),
          p_ooredoo: $("#payment-ooredoo").value.trim(),
          p_flouci: $("#payment-flouci").value.trim(),
        });
        toast("Coordonnées de paiement partagées avec tous les membres.");
      }
    }
  } catch (error) {
    toast(error.message || "Une erreur est survenue.", true);
  }
});

document.addEventListener("submit", handleModalSubmit);
document.addEventListener("change", event => {
  if (event.target.id === "avatar-file") {
    const file = event.target.files?.[0];
    if (file) {
      const preview = $("#avatar-preview");
      preview.src = URL.createObjectURL(file);
      preview.classList.remove("hidden");
    }
  }
  if (event.target.id === "post-file") {
    const files = [...event.target.files];
    if (!files.length) return;
    const hasVideo = files.some(file => file.type.startsWith("video/"));
    if (hasVideo && files.length > 1 || hasVideo && files.some(file => !file.type.startsWith("video/"))) {
      event.target.value = "";
      $("#post-preview-list").innerHTML = "";
      $("#upload-cost").textContent = "Une vidéo seule, ou jusqu'à 6 photos.";
      toast("Choisis une vidéo seule ou uniquement des photos.", true);
      return;
    }
    if (files.length > 6) {
      event.target.value = "";
      $("#post-preview-list").innerHTML = "";
      toast("Six photos maximum par publication.", true);
      return;
    }
    $("#post-preview-list").innerHTML = files.map(file => {
      const source = URL.createObjectURL(file);
      return file.type.startsWith("video/")
        ? `<video src="${escapeHTML(source)}" muted controls></video>`
        : `<img src="${escapeHTML(source)}" alt="${escapeHTML(file.name)}">`;
    }).join("");
    const cost = hasVideo ? 2 : files.length;
    $("#upload-cost").textContent = `${hasVideo ? "Vidéo : 2 points" : `${files.length} photo${files.length > 1 ? "s" : ""} : ${cost} point${cost > 1 ? "s" : ""}`} · Solde : ${state.profile.points} points`;
  }
  if (event.target.id === "receipt-file") {
    const file = event.target.files?.[0];
    if (file) {
      $("#receipt-preview").src = URL.createObjectURL(file);
      $("#receipt-preview").classList.remove("hidden");
      $$(".payment-steps span").forEach((step, index) => step.classList.toggle("active", index === 2));
    }
  }
  if (event.target.id === "message-attachment") {
    const file = event.target.files?.[0];
    if (file) {
      recordedMessageFile = null;
      $("#message-attachment-name").textContent = file.name;
    }
  }
  if (event.target.name === "provider") {
    const form = $("#points-form");
    const numbers = JSON.parse(form.dataset.numbers);
    $("#payment-destination").textContent = numbers[event.target.value];
    $("#payment-destination-label").textContent = `Coordonnée ${event.target.value} Marketplace TN`;
    $$(".payment-steps span").forEach((step, index) => step.classList.toggle("active", index === 1));
  }
  if (event.target.name === "package") {
    const offer = pointPackages[Number(event.target.value)];
    if (!offer) return;
    $('input[name="amount"]', $("#points-form")).value = offer.points;
    $("#package-summary").textContent = `${offer.detail} · À payer : ${offer.price} DT`;
  }
});

$("#search-input").addEventListener("input", event => {
  state.search = event.target.value;
  clearTimeout(renderFeed.timer);
  if (state.page === "feed") renderFeed.timer = setTimeout(() => renderPage(), 240);
});

document.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    $("#search-input").focus();
  }
  if (event.key === "Escape") {
    discardMessageRecording();
    $("#modal-root").innerHTML = "";
  }
});

async function start() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error(`Configuration indisponible (${response.status}).`);
    state.config = await responseJSON(response);
  } catch (error) {
    $("#auth-error").textContent = `Connexion au serveur impossible. ${error.message}`;
  }
  if (state.config) await checkSetup();
  if (!state.setupReady) return;
  if (state.config && (location.search || location.hash)) {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const oauthError = params.get("error_description") || params.get("error");
    if (oauthError) {
      const oauthErrorLower = oauthError.toLowerCase();
      localStorage.removeItem(PKCE_VERIFIER_KEY);
      history.replaceState(null, "", location.pathname);
      let message = `Connexion Google impossible : ${oauthError}`;
      if (/redirect_uri_mismatch/i.test(oauthError)) {
        message = "Google refuse le callback. Dans Google Cloud Console → APIs & Services → Credentials, ouvre le client OAuth Web utilisé dans Supabase, puis ajoute exactement https://pufekqipizaqdxtbwcrl.supabase.co/auth/v1/callback à Authorized redirect URIs (pas à JavaScript origins).";
      } else if (
        oauthErrorLower.includes("unable to exchange external code")
        || oauthErrorLower.includes("unexpected_failure")
      ) {
        message = "Google a renvoyé vers Supabase, mais Supabase n'a pas pu valider le code. Dans Supabase → Authentication → Sign In / Providers → Google, vérifie que le Client ID et le Client Secret appartiennent au même client OAuth Web dans Google Cloud. Dans Google Cloud, vérifie que son Authorized redirect URI est exactement https://pufekqipizaqdxtbwcrl.supabase.co/auth/v1/callback. Si le secret a été renouvelé ou partagé, génère-en un nouveau, remplace-le dans Supabase, puis enregistre. Ne partage jamais le secret ici. Réessaie ensuite dans une fenêtre privée.";
      }
      showAuthError(message);
      return;
    }
    if (code) {
      const verifier = localStorage.getItem(PKCE_VERIFIER_KEY);
      localStorage.removeItem(PKCE_VERIFIER_KEY);
      history.replaceState(null, "", location.pathname);
      if (!verifier) {
        $("#auth-error").textContent = "La connexion Google a expiré. Réessaie.";
        return;
      }
      try {
        const session = await authRequest("token?grant_type=pkce", {
          auth_code: code,
          code_verifier: verifier,
        });
        session.expires_at = Math.floor(Date.now() / 1000) + (session.expires_in || 3600);
        localStorage.setItem("souqna-session", JSON.stringify(session));
        state.session = session;
      } catch (error) {
        $("#auth-error").textContent = `Connexion Google impossible : ${error.message}`;
        return;
      }
    }
  }
  state.session = await restoreSession();
  if (!state.session) {
    state.guestMode = true;
    setAuthScreen(false);
    await renderPage();
    return;
  }
  try {
    await loadProfile();
    await renderPage();
  } catch (error) {
    if (!state.session) return;
    $("#main-content").innerHTML = emptyHTML("!", "Connexion indisponible.", error.message);
  }
}

start();

async function checkSetup() {
  const notice = $("#setup-notice");
  try {
    const response = await fetch("/api/setup-status");
    const result = await responseJSON(response);
    if (!response.ok) throw new Error(result?.detail || `Vérification Supabase impossible (${response.status}).`);
    state.setupReady = result.ready === true;
    state.schemaUpgradeRequired = state.setupReady && result.upgradeRequired === true;
    notice.classList.toggle("hidden", state.setupReady && !state.schemaUpgradeRequired);
    if (!state.setupReady) {
      $("#setup-notice strong").textContent = "Il reste une étape pour démarrer";
      $("#setup-notice p").textContent = "La base Marketplace TN n'est pas encore installée dans Supabase. Dans Supabase → SQL Editor, ouvre le script ci-dessous, colle-le, puis clique sur Run.";
    } else if (state.schemaUpgradeRequired) {
      $("#setup-notice strong").textContent = "Mise à jour de la base nécessaire";
      $("#setup-notice p").textContent = "Le site fonctionne, mais Supabase utilise encore l'ancien schéma. Télécharge puis exécute le script SQL mis à jour pour réparer les fonctions d'administration et activer les photos multiples et le zoom.";
    }
    $("#auth-submit").disabled = !state.setupReady;
    $("#google-signin").disabled = !state.setupReady;
    if (state.setupReady && !state.schemaUpgradeRequired) $("#auth-error").textContent = "";
  } catch (error) {
    state.setupReady = false;
    state.schemaUpgradeRequired = false;
    notice.classList.remove("hidden");
    $("#setup-notice strong").textContent = "Supabase est temporairement inaccessible";
    $("#setup-notice p").textContent = error.message;
    $("#auth-submit").disabled = true;
    $("#google-signin").disabled = true;
  }
}

$("#check-setup").addEventListener("click", async () => {
  $("#setup-notice strong").textContent = "Vérification de Supabase...";
  await checkSetup();
  if (state.setupReady && state.schemaUpgradeRequired) {
    showAuthError("Le site est en ligne, mais la mise à jour SQL doit encore être exécutée.");
  } else if (state.setupReady) {
    showAuthError("La base Marketplace TN est prête. Tu peux te connecter ou créer un compte.");
  }
});
