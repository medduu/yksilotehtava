const API_URL = "https://media2.edu.metropolia.fi/restaurant/api/v1";
const FINLAND_CENTER = [25.5, 63.5];
const FINLAND_ZOOM = 5.2;
const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function distanceKm([lon1, lat1], [lon2, lat2]) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

function resizeImage(file, size = 160) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;
      canvas.getContext("2d").drawImage(img, sx, sy, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read the image"));
    };
    img.src = url;
  });
}

const menuCache = new Map();

async function fetchJson(path) {
  const res = await fetch(`${API_URL}${path}`);
  if (res.status === 404) return null;  
  if (!res.ok) throw new Error(`Request failed (${res.status}): ${path}`);
  return res.json();
}

async function getMenu(id, type) {
  const key = `${type}:${id}`;
  if (!menuCache.has(key)) menuCache.set(key, await fetchJson(`/restaurants/${type}/${id}/en`));
  return menuCache.get(key);
}

function formatPrice(price) {
  if (typeof price === "number") return price.toFixed(2) + " €";
  return price || "";
}

function dishHtml(item) {
  const diets = Array.isArray(item.diets)
    ? item.diets
    : String(item.diets || "").split(",").map((d) => d.trim()).filter(Boolean);
  const dietTags = diets.map((d) => `<span class="diet">${d}</span>`).join("");
  return `<li class="dish"><h3>${item.name}</h3><p class="price">${formatPrice(item.price)}</p><p>${dietTags}</p></li>`;
}

function todayHtml(data) {
  const courses = (data && data.courses) || [];
  return courses.length
    ? `<ul class="menu-grid">${courses.map(dishHtml).join("")}</ul>`
    : "<p>No menu for today. Try this week's menu.</p>";
}

function weekHtml(data) {
  const days = ((data && data.days) || []).filter((d) => d.courses && d.courses.length);
  if (days.length === 0) return "<p>No menu for this week.</p>";
  return days.map((d) => {
    const label = new Date(d.date).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "numeric" });
    return `<h4>${label}</h4><ul class="menu-grid">${d.courses.map(dishHtml).join("")}</ul>`;
  }).join("");
}

let currentUser = localStorage.getItem("currentUser");
let selectedId = null;     
let dialogTab = "today";  
let pendingFavId = null;    
let pendingFavOnly = false; 
let userPos = null;          
let query = "";
let city = "";
let favOnly = false;        

const authDialog = document.getElementById("auth-dialog");
const authForm = document.getElementById("auth-form");
const authTitle = document.getElementById("auth-title");
const usernameRow = document.getElementById("username-row");
const usernameInput = document.getElementById("auth-username");
const emailInput = document.getElementById("auth-email");
const passwordInput = document.getElementById("auth-password");
const authError = document.getElementById("auth-error");
const authSubmit = document.getElementById("auth-submit");
const authSwitch = document.getElementById("auth-switch");
const authButton = document.getElementById("auth-button");
const userName = document.getElementById("user-name");
let authMode = "login";

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === "signup";
  authTitle.textContent = signup ? "Sign up" : "Log in";
  usernameRow.hidden = !signup;
  usernameInput.required = signup;
  passwordInput.autocomplete = signup ? "new-password" : "current-password";
  authSubmit.textContent = signup ? "Create account" : "Log in";
  authSwitch.textContent = signup ? "Already have an account? Log in" : "No account yet? Sign up";
  authError.textContent = "";
}

function openAuth(mode = "login") {
  authForm.reset();
  setAuthMode(mode);
  authDialog.showModal();
}

async function hashPassword(password) {
  const bytes = new TextEncoder().encode(password);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const profileButton = document.getElementById("profile-button");
const headerAvatar = document.getElementById("header-avatar");

function getUser() {
  return currentUser ? readJson("users", {})[currentUser] : null;
}

function setAvatar(el, user) {
  if (user && user.avatar) {
    el.style.backgroundImage = `url(${user.avatar})`;
    el.textContent = "";
  } else {
    el.style.backgroundImage = "";
    el.textContent = user ? user.username.charAt(0).toUpperCase() : "";
  }
}

function updateUserUi() {
  const user = getUser();
  profileButton.hidden = !user;
  userName.textContent = user ? user.username : "";
  setAvatar(headerAvatar, user);
  authButton.textContent = currentUser ? "Log out" : "Log in";
}

authButton.addEventListener("click", () => {
  if (currentUser) {
    currentUser = null;
    favOnly = false;
    localStorage.removeItem("currentUser");
    updateUserUi();
    renderAll();
  } else {
    openAuth("login");
  }
});

authSwitch.addEventListener("click", () => setAuthMode(authMode === "login" ? "signup" : "login"));
document.getElementById("auth-close").addEventListener("click", () => authDialog.close());

authDialog.addEventListener("close", () => {
  pendingFavId = null;
  pendingFavOnly = false;
});

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = emailInput.value.trim().toLowerCase();
  const hash = await hashPassword(passwordInput.value);
  const users = readJson("users", {});

  if (authMode === "signup") {
    if (users[email]) {
      authError.textContent = "An account with this email already exists.";
      return;
    }
    users[email] = { username: usernameInput.value.trim(), hash };
    localStorage.setItem("users", JSON.stringify(users));
  } else if (!users[email] || users[email].hash !== hash) {
    authError.textContent = "Incorrect email or password.";
    return;
  }

  currentUser = email;
  localStorage.setItem("currentUser", email);
  const favId = pendingFavId;
  const wantFavOnly = pendingFavOnly;
  pendingFavId = null;
  pendingFavOnly = false;
  authDialog.close();
  updateUserUi();

  if (favId) toggleFav(favId);
  else if (wantFavOnly) setFavOnly(true);
  else renderAll();
});

const profileDialog = document.getElementById("profile-dialog");
const profileAvatar = document.getElementById("profile-avatar");
const profileUsername = document.getElementById("profile-username");
const profileEmail = document.getElementById("profile-email");
const profileError = document.getElementById("profile-error");
const avatarInput = document.getElementById("avatar-input");

function renderProfile() {
  const user = getUser();
  profileUsername.textContent = user.username;
  profileEmail.textContent = currentUser;
  setAvatar(profileAvatar, user);
  profileError.textContent = "";
}

function saveAvatar(avatar) {
  const users = readJson("users", {});
  if (avatar) users[currentUser].avatar = avatar;
  else delete users[currentUser].avatar;
  localStorage.setItem("users", JSON.stringify(users));
  renderProfile();
  updateUserUi();
}

profileButton.addEventListener("click", () => {
  if (!getUser()) return;
  renderProfile();
  profileDialog.showModal();
});
document.getElementById("avatar-change").addEventListener("click", () => avatarInput.click());
document.getElementById("avatar-remove").addEventListener("click", () => saveAvatar(null));
document.getElementById("profile-close").addEventListener("click", () => profileDialog.close());

avatarInput.addEventListener("change", async () => {
  const file = avatarInput.files[0];
  avatarInput.value = "";
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    profileError.textContent = "Please choose an image file.";
    return;
  }
  try {
    saveAvatar(await resizeImage(file));
  } catch (err) {
    profileError.textContent = "Could not save the image. Try another image.";
  }
});

function getFavs() {
  return currentUser ? readJson(`favs:${currentUser}`, []) : [];
}

function toggleFav(id) {
  if (!currentUser) {
    pendingFavId = id;  
    openAuth("login");
    return;
  }
  const favs = getFavs();
  const next = favs.includes(id) ? favs.filter((f) => f !== id) : [...favs, id];
  localStorage.setItem(`favs:${currentUser}`, JSON.stringify(next));
  renderAll();
}

function favButton(id) {
  const on = getFavs().includes(id);
  const label = on ? "Remove from favourites" : "Add to favourites";
  return `<button type="button" class="fav-btn" data-id="${id}" aria-pressed="${on}" aria-label="${label}">${on ? "♥" : "♡"}</button>`;
}

function nameButton(r) {
  const cls = r._id === selectedId ? "restaurant-name highlight" : "restaurant-name";
  return `<button type="button" class="${cls}" data-id="${r._id}">${r.name}</button>`;
}

const restList = document.getElementById("rest-list");
const resultCount = document.getElementById("result-count");
const locateMsg = document.getElementById("locate-msg");
const navAll = document.getElementById("nav-all");
const navFav = document.getElementById("fav-toggle");

function getVisible() {
  const q = query.trim().toLowerCase();
  const favs = favOnly ? getFavs() : null;
  const list = restaurants.filter((r) =>
    (!favs || favs.includes(r._id)) &&
    (!city || r.city === city) &&
    (!q || `${r.name} ${r.address} ${r.city} ${r.company}`.toLowerCase().includes(q)));
  return userPos
    ? list.sort((a, b) => distanceKm(userPos, a.location.coordinates) - distanceKm(userPos, b.location.coordinates))
    : list.sort((a, b) => a.name.localeCompare(b.name));
}

function itemHtml(r) {
  const dist = userPos ? ` · ${distanceKm(userPos, r.location.coordinates).toFixed(1)} km away` : "";
  return `
    <li class="rest-item">
      ${nameButton(r)}
      ${favButton(r._id)}
      <span class="rest-meta">${r.address}, ${r.city} · ${r.company}${dist}</span>
    </li>`;
}

function renderDirectory() {
  const list = getVisible();
  const empty = favOnly
    ? "You have no favourites yet. Press the ♡ next to a restaurant to add it here."
    : "No restaurants found.";
  restList.innerHTML = list.length ? list.map(itemHtml).join("") : `<li class="rest-empty">${empty}</li>`;
  const noun = favOnly ? "favourite" : "restaurant";
  resultCount.textContent = `${list.length} ${noun}${list.length === 1 ? "" : "s"}`;
  navAll.setAttribute("aria-pressed", String(!favOnly));
  navFav.setAttribute("aria-pressed", String(favOnly));
  const favCount = getFavs().length;
  navFav.innerHTML = `&#9829; Favourites${favCount ? ` (${favCount})` : ""}`;
  updateMap();
}

function setFavOnly(on) {
  favOnly = on;
  renderAll();
  fitToList(getVisible());
  document.querySelector(".rest-panel").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  locateMsg.textContent = on ? "Showing your favourites only. Press “All restaurants” to see everything." : "";
}

navAll.addEventListener("click", () => setFavOnly(false));
navFav.addEventListener("click", () => {
  if (!currentUser) {
    pendingFavOnly = true; 
    openAuth("login");
    return;
  }
  setFavOnly(true);
});

document.getElementById("search").addEventListener("input", (e) => {
  query = e.target.value;
  renderDirectory();
});

const cityFilter = document.getElementById("city-filter");
[...new Set(restaurants.map((r) => r.city))].sort().forEach((c) => {
  const option = document.createElement("option");
  option.value = c;
  option.textContent = c;
  cityFilter.append(option);
});
cityFilter.addEventListener("change", () => {
  city = cityFilter.value;
  renderDirectory();
  fitToList(getVisible());
});

const mapEl = document.getElementById("map");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let map = null;
let mapReady = false;
let userMarker = null;

function toGeoJson(list) {
  return {
    type: "FeatureCollection",
    features: list.map((r) => ({
      type: "Feature",
      properties: { id: r._id, name: r.name },
      geometry: { type: "Point", coordinates: r.location.coordinates },
    })),
  };
}

function updateMap() {
  if (mapReady) map.getSource("restaurants").setData(toGeoJson(getVisible()));
}

function fitToList(list) {
  if (!mapReady || list.length === 0) return;
  const bounds = new maplibregl.LngLatBounds();
  list.forEach((r) => bounds.extend(r.location.coordinates));
  map.fitBounds(bounds, { padding: 60, maxZoom: 12, duration: reduceMotion ? 0 : 1200 });
}

function showMapError() {
  mapEl.innerHTML = '<p class="map-error">The map could not be loaded. Check your internet connection and that WebGL is enabled in your browser. The restaurant list still works.</p>';
}

async function addRestaurantLayers() {
  let hasPinImage = false;
  try {
    const icon = await map.loadImage("images/marker.png");
    map.addImage("pin", icon.data);
    hasPinImage = true;
  } catch (err) {
    console.error("Could not load images/marker.png, using round dots instead", err);
  }

  map.addSource("restaurants", {
    type: "geojson",
    data: toGeoJson(getVisible()),
    cluster: true,
    clusterRadius: 50,
    clusterMaxZoom: 11,
  });

  map.addLayer({
    id: "clusters",
    type: "circle",
    source: "restaurants",
    filter: ["has", "point_count"],
    paint: {
      "circle-color": "#5a1a2b",
      "circle-radius": ["step", ["get", "point_count"], 16, 5, 21, 15, 27],
      "circle-stroke-width": 3,
      "circle-stroke-color": "#c8963e",
    },
  });
  map.addLayer({
    id: "cluster-count",
    type: "symbol",
    source: "restaurants",
    filter: ["has", "point_count"],
    layout: {
      "text-field": ["get", "point_count_abbreviated"],
      "text-font": ["Noto Sans Bold"],
      "text-size": 13,
    },
    paint: { "text-color": "#ffffff" },
  });

  map.addLayer({
    id: "points-dot",
    type: "circle",
    source: "restaurants",
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": "#5a1a2b",
      "circle-radius": hasPinImage ? 3 : 8,
      "circle-stroke-width": 2,
      "circle-stroke-color": "#c8963e",
    },
  });
  if (hasPinImage) map.addLayer({
    id: "points",
    type: "symbol",
    source: "restaurants",
    filter: ["!", ["has", "point_count"]],
    layout: {
      "icon-image": "pin",
      "icon-size": 0.3,
      "icon-anchor": "bottom",
      "icon-allow-overlap": true,
    },
  });

  map.on("click", "clusters", async (e) => {
    const feature = e.features[0];
    const zoom = await map.getSource("restaurants").getClusterExpansionZoom(feature.properties.cluster_id);
    map.easeTo({ center: feature.geometry.coordinates, zoom: zoom + 0.5, duration: reduceMotion ? 0 : 800 });
  });
  const pointLayer = hasPinImage ? "points" : "points-dot";
  map.on("click", pointLayer, (e) => openRestaurantDialog(e.features[0].properties.id));
  ["clusters", pointLayer].forEach((layer) => {
    map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
  });

  mapReady = true;
}

function initMap() {
  if (typeof maplibregl === "undefined") {
    showMapError();
    return;
  }
  try {
    map = new maplibregl.Map({ container: "map", style: MAP_STYLE, center: FINLAND_CENTER, zoom: FINLAND_ZOOM });
  } catch (err) {
    console.error(err);
    showMapError();
    return;
  }
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

  map.on("style.load", () => {
    map.setProjection({ type: "globe" }); 
    try {
      map.setSky({ "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 7, 0] });
    } catch (err) {
      console.warn("Sky not supported", err);
    }
  });
  map.on("load", () => addRestaurantLayers().catch((err) => console.error(err)));
  map.on("error", (e) => console.error("Map error:", e && e.error ? e.error : e));
}

const dialog = document.getElementById("restaurant-dialog");

async function fillDialogMenu() {
  const box = document.getElementById("dialog-menu");
  const id = selectedId;
  const tab = dialogTab;
  box.textContent = "Loading menu…";
  try {
    const data = await getMenu(id, tab === "today" ? "daily" : "weekly");
    if (id !== selectedId || tab !== dialogTab) return; 
    box.innerHTML = tab === "today" ? todayHtml(data) : weekHtml(data);
  } catch (err) {
    console.error(err);
    box.textContent = "Could not load the menu. Please try again later.";
  }
}

function renderDialog() {
  const r = restaurants.find((item) => item._id === selectedId);
  const [lon, lat] = r.location.coordinates;
  const phone = r.phone && r.phone !== "-" ? ` · ${r.phone}` : "";
  dialog.innerHTML = `
    <div class="dialog-head">
      <h3>${r.name}</h3>
      ${favButton(r._id)}
    </div>
    <p class="legend">${r.address}, ${r.postalCode} ${r.city}<br>${r.company}${phone}</p>
    <p><a href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}" target="_blank" rel="noopener">Get directions</a></p>
    <div class="tabs" role="group" aria-label="Menu type">
      <button type="button" class="tab-btn" data-tab="today" aria-pressed="${dialogTab === "today"}">Today's menu</button>
      <button type="button" class="tab-btn" data-tab="week" aria-pressed="${dialogTab === "week"}">This week's menu</button>
    </div>
    <div id="dialog-menu" class="dialog-menu" aria-live="polite"></div>
    <p class="legend">G = gluten-free, L = lactose-free, M = dairy-free, VL = low-lactose, Veg = vegan</p>
    <div class="dialog-actions">
      <button class="btn btn-outline" id="close-dialog" type="button">Close</button>
    </div>`;
  fillDialogMenu();
}

function renderAll() {
  renderDirectory();
  if (dialog.open && selectedId) renderDialog();
}

function openRestaurantDialog(id, flyTo = false) {
  selectedId = id;
  dialogTab = "today";
  if (flyTo && mapReady) {
    const r = restaurants.find((item) => item._id === id);
    map.flyTo({ center: r.location.coordinates, zoom: Math.max(map.getZoom(), 12), duration: reduceMotion ? 0 : 1500 });
  }
  renderDialog();
  if (!dialog.open) dialog.showModal();
  renderDirectory();
}

document.addEventListener("click", (event) => {
  const nameBtn = event.target.closest(".restaurant-name");
  if (nameBtn) { openRestaurantDialog(nameBtn.dataset.id, true); return; }

  const favBtn = event.target.closest(".fav-btn");
  if (favBtn) { toggleFav(favBtn.dataset.id); return; }

  const tabBtn = event.target.closest(".tab-btn");
  if (tabBtn) { dialogTab = tabBtn.dataset.tab; renderDialog(); return; }

  if (event.target.closest("#close-dialog")) dialog.close();
});

const locateBtn = document.getElementById("locate-btn");

locateBtn.addEventListener("click", () => {
  if (!("geolocation" in navigator)) {
    locateMsg.textContent = "Your browser does not support location.";
    return;
  }
  locateMsg.textContent = "Getting your location…";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userPos = [pos.coords.longitude, pos.coords.latitude];
      if (mapReady) {
        if (userMarker) userMarker.remove();
        userMarker = new maplibregl.Marker({ color: "#e53935" }).setLngLat(userPos).addTo(map); 
        map.flyTo({ center: userPos, zoom: 11, duration: reduceMotion ? 0 : 2000 });
      }
      locateMsg.textContent = "Showing the closest restaurants first.";
      renderAll();
    },
    (err) => {
      locateMsg.textContent = err.code === err.PERMISSION_DENIED
        ? "Location access was denied. Restaurants are listed alphabetically."
        : "Could not get your location. Please try again later.";
    },
    { timeout: 10000 }
  );
});

updateUserUi();
renderDirectory();
initMap();