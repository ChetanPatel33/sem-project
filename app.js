/**
 * ResQNear — Emergency Resource Locator
 * Frontend Application Logic
 * API_BASE points to your Node.js backend
 */

const API_BASE = "http://localhost:3000/api";

// ===== APP STATE =====
let currentUser = null;       // { id, name, email, role }
let currentFilter = "all";
let userLat = null, userLng = null;
let allResources = [];        // raw data from last fetch
let map = null, userMarker = null, userCircle = null, resourceMarkers = [];
let directionsService = null, directionsRenderer = null;
let sosTimer = null;
let googleMapsLoaded = false;

// ===== INIT =====
window.addEventListener("load", () => {
  setTimeout(() => {
    document.getElementById("loader").classList.add("fade-out");
  }, 1500);
  loadSession();
  initVoiceSearch();
});

// ===== SESSION =====
function loadSession() {
  const saved = localStorage.getItem("resqnear_user");
  if (saved) {
    currentUser = JSON.parse(saved);
    updateNavForUser();
  }
}

function saveSession(user) {
  currentUser = user;
  localStorage.setItem("resqnear_user", JSON.stringify(user));
  updateNavForUser();
}

function updateNavForUser() {
  if (currentUser) {
    document.getElementById("authBtn").classList.add("hidden");
    document.getElementById("userMenuBtn").classList.remove("hidden");
    document.getElementById("userName").textContent = currentUser.name.split(" ")[0];
    if (currentUser.role === "admin") {
      document.getElementById("adminLink").classList.remove("hidden");
    }
  } else {
    document.getElementById("authBtn").classList.remove("hidden");
    document.getElementById("userMenuBtn").classList.add("hidden");
    document.getElementById("adminLink").classList.add("hidden");
  }
}

// ===== AUTH MODAL =====
function openAuth() { document.getElementById("authModal").classList.remove("hidden"); }
function closeAuth() { document.getElementById("authModal").classList.add("hidden"); }

function switchTab(tab) {
  document.getElementById("loginForm").classList.toggle("hidden", tab !== "login");
  document.getElementById("registerForm").classList.toggle("hidden", tab !== "register");
  document.querySelectorAll(".auth-tabs .tab-btn").forEach((b, i) => {
    b.classList.toggle("active", (i === 0 && tab === "login") || (i === 1 && tab === "register"));
  });
}

async function login() {
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errEl = document.getElementById("loginError");
  errEl.textContent = "";
  if (!email || !password) { errEl.textContent = "Please fill all fields."; return; }

  try {
    const res = await apiPost("/auth/login", { email, password });
    saveSession(res.user);
    closeAuth();
    showToast("Welcome back, " + res.user.name + "!", "success");
  } catch (e) {
    errEl.textContent = e.message || "Login failed.";
  }
}

async function register() {
  const name = document.getElementById("regName").value.trim();
  const email = document.getElementById("regEmail").value.trim();
  const password = document.getElementById("regPassword").value;
  const phone = document.getElementById("regPhone").value.trim();
  const emergency_contact = document.getElementById("regEmergencyContact").value.trim();
  const errEl = document.getElementById("registerError");
  errEl.textContent = "";
  if (!name || !email || !password) { errEl.textContent = "Name, email and password are required."; return; }

  try {
    const res = await apiPost("/auth/register", { name, email, password, phone, emergency_contact });
    saveSession(res.user);
    closeAuth();
    showToast("Account created! Welcome, " + res.user.name + "!", "success");
  } catch (e) {
    errEl.textContent = e.message || "Registration failed.";
  }
}

function continueAsGuest() {
  closeAuth();
  showToast("Emergency mode: searching without login", "info");
  if (navigator.geolocation) detectLocation();
}

function logout() {
  currentUser = null;
  localStorage.removeItem("resqnear_user");
  updateNavForUser();
  document.getElementById("userMenu").classList.add("hidden");
  showToast("Logged out", "info");
}

function toggleUserMenu() {
  document.getElementById("userMenu").classList.toggle("hidden");
}

// Close dropdown on outside click
document.addEventListener("click", (e) => {
  if (!e.target.closest(".nav-actions")) {
    document.getElementById("userMenu").classList.add("hidden");
  }
});

// ===== LOCATION =====
function detectLocation() {
  if (!navigator.geolocation) { showToast("Geolocation not supported", "error"); return; }
  document.getElementById("locationStatus").textContent = "🛰 Detecting location...";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userLat = pos.coords.latitude;
      userLng = pos.coords.longitude;
      document.getElementById("locationStatus").textContent =
        `📍 ${userLat.toFixed(6)}, ${userLng.toFixed(6)}`;
      initOrUpdateMap(userLat, userLng);
      fetchNearbyResources();
    },
    (err) => {
      document.getElementById("locationStatus").textContent = "⚠ Location denied";
      showToast("Location access denied. Search manually.", "error");
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

// ===== MAP (Google Maps) =====
function initOrUpdateMap(lat, lng) {
  if (typeof google === "undefined") {
    // Google Maps not loaded — show static placeholder with coordinates
    document.getElementById("map").innerHTML = `
      <div class="map-placeholder">
        <div class="map-placeholder-inner">
          <div class="map-pulse">📍</div>
          <p>Location Detected</p>
          <small style="font-family:var(--font-mono); color:var(--red)">${lat.toFixed(5)}, ${lng.toFixed(5)}</small>
          <br/><small style="margin-top:8px; display:block">Add Google Maps API key in index.html to enable live map</small>
        </div>
      </div>`;
    return;
  }

  if (!map) {
    map = new google.maps.Map(document.getElementById("map"), {
      center: { lat, lng }, zoom: 16,
      styles: darkMapStyle(),
      disableDefaultUI: false,
    });
  } else {
    map.panTo({ lat, lng });
    map.setZoom(16);
  }

  if (userMarker) userMarker.setMap(null);
  if (userCircle) userCircle.setMap(null);
  
  userMarker = new google.maps.Marker({
    position: { lat, lng }, map,
    title: "You are here",
    icon: { url: "https://maps.google.com/mapfiles/ms/icons/blue-dot.png" },
    animation: google.maps.Animation.BOUNCE,
    zIndex: 999
  });

  userCircle = new google.maps.Circle({
    strokeColor: "#4285F4",
    strokeOpacity: 0.6,
    strokeWeight: 2,
    fillColor: "#4285F4",
    fillOpacity: 0.2,
    map,
    center: { lat, lng },
    radius: 300 // 300 meters highlight radius
  });
}

function placeResourceMarkers(resources) {
  if (!map) return;
  resourceMarkers.forEach(m => m.setMap(null));
  resourceMarkers = [];

  const bounds = new google.maps.LatLngBounds();
  let hasValidMarkers = false;

  if (userLat && userLng) {
    bounds.extend({ lat: parseFloat(userLat), lng: parseFloat(userLng) });
    hasValidMarkers = true;
  }

  resources.forEach(r => {
    if (!r.latitude || !r.longitude) return;
    const pos = { lat: parseFloat(r.latitude), lng: parseFloat(r.longitude) };
    const marker = new google.maps.Marker({
      position: pos,
      map,
      title: r.name,
      icon: { url: iconForType(r.type) },
    });
    marker.addListener("click", () => openDetail(r));
    resourceMarkers.push(marker);
    bounds.extend(pos);
    hasValidMarkers = true;
  });

  if (hasValidMarkers) {
    map.fitBounds(bounds);
    const listener = google.maps.event.addListener(map, "idle", function() { 
      if (map.getZoom() > 16) map.setZoom(16); 
      google.maps.event.removeListener(listener); 
    });
  }
}

function iconForType(type) {
  const icons = {
    hospital: "https://maps.google.com/mapfiles/ms/icons/hospitals.png",
    police: "https://maps.google.com/mapfiles/ms/icons/police.png",
    fire: "https://maps.google.com/mapfiles/ms/icons/firedept.png",
    ambulance: "https://maps.google.com/mapfiles/ms/icons/red-dot.png",
    blood_bank: "https://maps.google.com/mapfiles/ms/icons/pink-dot.png",
  };
  return icons[type] || "https://maps.google.com/mapfiles/ms/icons/red-dot.png";
}

function showRouteOnMap(destLat, destLng, destName) {
  if (!userLat || !userLng) {
    showToast("Your location is not detected. Please detect location first.", "error");
    return;
  }

  if (typeof google === "undefined") {
    showToast("Google Maps not loaded.", "error");
    return;
  }

  closeDetail(); // Close modal to show map

  if (!directionsService) {
    directionsService = new google.maps.DirectionsService();
    directionsRenderer = new google.maps.DirectionsRenderer({
      map: map,
      suppressMarkers: false
    });
  }

  const request = {
    origin: { lat: parseFloat(userLat), lng: parseFloat(userLng) },
    destination: { lat: parseFloat(destLat), lng: parseFloat(destLng) },
    travelMode: google.maps.TravelMode.DRIVING
  };

  directionsService.route(request, function (result, status) {
    if (status === 'OK') {
      directionsRenderer.setDirections(result);
      const distance = result.routes[0].legs[0].distance.text;
      const duration = result.routes[0].legs[0].duration.text;
      showToast(`Route to ${destName}: Distance ${distance}, Time ${duration}`, "info");
      document.querySelector('.map-container').scrollIntoView({ behavior: 'smooth' });
    } else {
      showToast("Could not calculate route: " + status, "error");
    }
  });
}

// ===== SEARCH =====
async function searchResources() {
  const query = document.getElementById("searchInput").value.trim();
  if (!query && !userLat) {
    showToast("Please detect location or enter an area", "error"); return;
  }

  try {
    let url = `/resources?type=${currentFilter}`;
    if (userLat) url += `&lat=${userLat}&lng=${userLng}`;
    if (query) url += `&q=${encodeURIComponent(query)}`;
    allResources = await apiGet(url);
    renderResults(allResources);
    placeResourceMarkers(allResources);
  } catch (e) {
    showToast("Failed to load resources: " + e.message, "error");
  }
}

async function fetchNearbyResources() {
  if (!userLat) return;
  await searchResources();
}

// ===== FILTER CHIPS =====
function filterChip(el, type) {
  document.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
  el.classList.add("active");
  currentFilter = type;
  if (userLat || document.getElementById("searchInput").value) searchResources();
}

// ===== RENDER RESULTS =====
function renderResults(resources) {
  const list = document.getElementById("resultsList");
  const badge = document.getElementById("resultCount");
  badge.textContent = resources.length + " found";

  if (!resources.length) {
    list.innerHTML = `<div class="empty-state"><span>😔</span><p>No resources found. Try a different filter or area.</p></div>`;
    return;
  }

  list.innerHTML = resources.map(r => `
    <div class="resource-card" onclick="openDetail(${JSON.stringify(r).replace(/"/g, '&quot;')})">
      <div class="resource-card-top">
        <div class="resource-name">${r.name}</div>
        <span class="resource-type-badge type-${r.type}">${typeLabel(r.type)}</span>
      </div>
      <div class="resource-meta">
        <span><span class="avail-dot avail-${r.availability}"></span> ${availLabel(r.availability)}</span>
        ${r.distance ? `<span>📍 ${r.distance} km</span>` : ""}
        ${r.contact ? `<span>📞 ${r.contact}</span>` : ""}
      </div>
      <div class="resource-card-actions" onclick="event.stopPropagation()">
        ${r.contact ? `<button class="call-btn" onclick="callNumber('${r.contact}')">📞 Call</button>` : `<button class="call-btn disabled" onclick="showToast('Number not available', 'error')">📞 Call</button>`}
        ${r.contact ? `<button class="msg-btn" onclick="sendMessage('${r.contact}')">💬 Message</button>` : `<button class="msg-btn disabled" onclick="showToast('Number not available', 'error')">💬 Message</button>`}
      </div>
    </div>
  `).join("");
}

// ===== DETAIL MODAL =====
function openDetail(r) {
  const el = document.getElementById("detailContent");
  el.innerHTML = `
    <div class="detail-header">
      <div class="detail-icon">${typeIcon(r.type)}</div>
      <div>
        <div class="resource-type-badge type-${r.type}" style="margin-bottom:4px">${typeLabel(r.type)}</div>
        <div class="detail-title">${r.name}</div>
      </div>
    </div>
    <div class="detail-rows">
      <div class="detail-row"><span class="label">Contact</span><span class="value">📞 ${r.contact || "N/A"}</span></div>
      <div class="detail-row"><span class="label">Address</span><span class="value" ${r.latitude && r.longitude ? `style="cursor:pointer;text-decoration:underline;" onclick="showRouteOnMap(${r.latitude}, ${r.longitude}, '${(r.name || '').replace(/'/g, "\\'")}')" title="Click to view route on map"` : ''}>📍 ${r.address || "N/A"}</span></div>
      <div class="detail-row"><span class="label">Status</span><span class="value"><span class="avail-dot avail-${r.availability}"></span> ${availLabel(r.availability)}</span></div>
      ${r.distance ? `<div class="detail-row"><span class="label">Distance</span><span class="value">🗺 ${r.distance} km away</span></div>` : ""}
    </div>
    ${r.contact ? `<button class="big-call-btn" onclick="callNumber('${r.contact}')">📞 CALL</button>` : `<button class="big-call-btn disabled" onclick="showToast('Number not available', 'error')">📞 CALL</button>`}
  `;
  document.getElementById("detailModal").classList.remove("hidden");
}

function closeDetail() { document.getElementById("detailModal").classList.add("hidden"); }

// ===== ONE-CLICK CALL =====
let currentCallNumber = "";

function callNumber(num) {
  if (!num || num === 'null' || num === 'undefined') { 
    showToast("Number not available", "error"); 
    return; 
  }
  
  const formattedNum = num.replace(/[-+\s]/g, "");
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  
  if (isMobile) {
    // Use native phone dialer with tel: scheme
    window.location.href = `tel:${formattedNum}`;
  } else {
    // Desktop: Try tel: in background and open modal
    window.location.href = `tel:${formattedNum}`;
    
    currentCallNumber = num;
    document.getElementById("callModalNumber").textContent = num;
    document.getElementById("skypeLink").href = `skype:${formattedNum}?call`;
    document.getElementById("desktopTelLink").href = `tel:${formattedNum}`;
    
    document.getElementById("callModal").classList.remove("hidden");
  }
}

function closeCallModal() {
  document.getElementById("callModal").classList.add("hidden");
}

function copyModalNumber() {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(currentCallNumber).then(() => {
      showToast("Number copied to clipboard! 📋", "success");
    }).catch(() => {
      showToast("Failed to copy number", "error");
    });
  } else {
    showToast("Clipboard not supported. Please copy manually.", "error");
  }
}

// ===== MESSAGE (WHATSAPP / SMS FALLBACK) =====
function sendMessage(num) {
  if (!num || num === 'null' || num === 'undefined') { 
    showToast("Number not available", "error"); 
    return; 
  }
  
  const formattedNum = num.replace(/[-+\s]/g, "");
  const message = "Emergency! I need help. Please contact me urgently.";
  const encodedMessage = encodeURIComponent(message);
  
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  
  if (isMobile) {
    // On mobile, try opening WhatsApp via intent
    window.location.href = `whatsapp://send?phone=${formattedNum}&text=${encodedMessage}`;
    
    // Set a timeout to fallback to SMS if WhatsApp intent doesn't background the app
    setTimeout(() => {
      if (!document.hidden) {
        window.location.href = `sms:${formattedNum}?body=${encodedMessage}`;
      }
    }, 600);
  } else {
    // On desktop, open WhatsApp Web in a new tab
    window.open(`https://wa.me/${formattedNum}?text=${encodedMessage}`, '_blank');
  }
}

// ===== SOS =====
function triggerSOS() {
  const overlay = document.getElementById("sosOverlay");
  overlay.style.display = "flex";          // show
  overlay.classList.remove("hidden");      // ensure it's not permanently hidden
  overlay.classList.add("active");

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition((pos) => {
      userLat = pos.coords.latitude;
      userLng = pos.coords.longitude;
      document.getElementById("sosCoords").textContent =
        `LAT: ${userLat.toFixed(6)}  |  LNG: ${userLng.toFixed(6)}`;
      if (currentUser && currentUser.id) {
        apiPost("/sos", {
          userId: currentUser.id,
          latitude: userLat,
          longitude: userLng,
        }).catch(() => { });
      }
    }, (err) => {
      console.error("SOS Location error:", err);
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
  }
  document.getElementById("sosMessage").textContent =
    "SOS Activated! Sending location to emergency contacts...";

  sosTimer = setTimeout(() => {
    document.getElementById("sosMessage").textContent =
      "Emergency services alerted. Stay calm.";
  }, 3000);
}

function cancelSOS() {
  clearTimeout(sosTimer);
  const overlay = document.getElementById("sosOverlay");
  overlay.style.display = "none";          // hide
  overlay.classList.remove("active");
  showToast("SOS cancelled", "info");
}

// ===== ADMIN PANEL =====
function openAdmin() {
  document.getElementById("userMenu").classList.add("hidden");
  document.getElementById("adminModal").classList.remove("hidden");
  adminTab("resources");
}

function closeAdmin() { document.getElementById("adminModal").classList.add("hidden"); }

function adminTab(tab) {
  ["resources", "users", "add"].forEach(t => {
    document.getElementById("admin" + t.charAt(0).toUpperCase() + t.slice(1)).classList.toggle("hidden", t !== tab);
  });
  document.querySelectorAll(".admin-tabs .tab-btn").forEach((b, i) => {
    b.classList.toggle("active", ["resources", "users", "add"].indexOf(tab) === i);
  });
  if (tab === "resources") loadAdminResources();
  if (tab === "users") loadAdminUsers();
}

async function loadAdminResources() {
  try {
    const data = await apiGet("/admin/resources", true);
    const list = document.getElementById("adminResourceList");
    if (!data.length) { list.innerHTML = "<p style='color:var(--muted);padding:1rem'>No resources yet.</p>"; return; }
    list.innerHTML = data.map(r => `
      <div class="admin-item">
        <div class="admin-item-info">
          <div class="admin-item-name">${typeIcon(r.type)} ${r.name}</div>
          <div class="admin-item-sub">${r.address || ""} | ${r.contact || ""} | <span class="avail-dot avail-${r.availability}"></span> ${availLabel(r.availability)}</div>
        </div>
        <div class="admin-item-actions">
          <button class="btn-toggle" onclick="adminToggleAvail(${r.id}, '${r.availability}')">Toggle</button>
          <button class="btn-delete" onclick="adminDeleteResource(${r.id})">Delete</button>
        </div>
      </div>
    `).join("");
  } catch (e) { showToast("Failed: " + e.message, "error"); }
}

async function loadAdminUsers() {
  try {
    const data = await apiGet("/admin/users", true);
    const list = document.getElementById("adminUserList");
    if (!data.length) { list.innerHTML = "<p style='color:var(--muted);padding:1rem'>No users yet.</p>"; return; }
    list.innerHTML = data.map(u => `
      <div class="admin-item">
        <div class="admin-item-info">
          <div class="admin-item-name">👤 ${u.name}</div>
          <div class="admin-item-sub">${u.email} | ${u.phone || "no phone"} | Role: ${u.role}</div>
        </div>
        <div class="admin-item-actions">
          <button class="btn-delete" onclick="adminDeleteUser(${u.id})">Remove</button>
        </div>
      </div>
    `).join("");
  } catch (e) { showToast("Failed: " + e.message, "error"); }
}

async function adminAddResource() {
  const body = {
    name: document.getElementById("aName").value.trim(),
    type: document.getElementById("aType").value,
    address: document.getElementById("aAddress").value.trim(),
    contact: document.getElementById("aContact").value.trim(),
    latitude: parseFloat(document.getElementById("aLat").value),
    longitude: parseFloat(document.getElementById("aLng").value),
    availability: document.getElementById("aAvailability").value,
  };
  const errEl = document.getElementById("addError");
  errEl.textContent = "";
  if (!body.name || !body.type) { errEl.textContent = "Name and type are required."; return; }
  try {
    await apiPost("/admin/resources", body, true);
    showToast("Resource added!", "success");
    adminTab("resources");
  } catch (e) { errEl.textContent = e.message; }
}

async function adminDeleteResource(id) {
  if (!confirm("Delete this resource?")) return;
  try {
    await apiDelete("/admin/resources/" + id, true);
    showToast("Resource deleted", "info");
    loadAdminResources();
  } catch (e) { showToast(e.message, "error"); }
}

async function adminToggleAvail(id, current) {
  const next = current === "available" ? "unavailable" : "available";
  try {
    await apiPatch("/admin/resources/" + id, { availability: next }, true);
    showToast("Availability updated", "success");
    loadAdminResources();
  } catch (e) { showToast(e.message, "error"); }
}

async function adminDeleteUser(id) {
  if (!confirm("Remove this user?")) return;
  try {
    await apiDelete("/admin/users/" + id, true);
    showToast("User removed", "info");
    loadAdminUsers();
  } catch (e) { showToast(e.message, "error"); }
}

// ===== VOICE SEARCH =====
function initVoiceSearch() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;
  const recognition = new SpeechRecognition();
  recognition.lang = "en-IN";
  recognition.onresult = (e) => {
    const text = e.results[0][0].transcript;
    document.getElementById("searchInput").value = text;
    searchResources();
  };
  // Add microphone button to search bar
  const micBtn = document.createElement("button");
  micBtn.textContent = "🎤";
  micBtn.className = "location-btn";
  micBtn.title = "Voice search";
  micBtn.onclick = () => recognition.start();
  document.querySelector(".search-bar").insertBefore(micBtn, document.querySelector(".search-btn"));
}

// ===== API HELPERS =====
async function apiGet(path, admin = false) {
  const headers = { "Content-Type": "application/json" };
  if (currentUser) headers["Authorization"] = "Bearer " + currentUser.token;
  const res = await fetch(API_BASE + path, { headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function apiPost(path, body, admin = false) {
  const headers = { "Content-Type": "application/json" };
  if (currentUser) headers["Authorization"] = "Bearer " + currentUser.token;
  const res = await fetch(API_BASE + path, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function apiDelete(path, admin = false) {
  const headers = { "Content-Type": "application/json" };
  if (currentUser) headers["Authorization"] = "Bearer " + currentUser.token;
  const res = await fetch(API_BASE + path, { method: "DELETE", headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function apiPatch(path, body, admin = false) {
  const headers = { "Content-Type": "application/json" };
  if (currentUser) headers["Authorization"] = "Bearer " + currentUser.token;
  const res = await fetch(API_BASE + path, {
    method: "PATCH", headers, body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

// ===== TOAST =====
let toastTimeout;
function showToast(msg, type = "info") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast " + type;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => t.classList.add("hidden"), 3500);
}

// ===== LABEL HELPERS =====
function typeLabel(t) {
  return { hospital: "Hospital", police: "Police", fire: "Fire Station", ambulance: "Ambulance", blood_bank: "Blood Bank" }[t] || t;
}
function typeIcon(t) {
  return { hospital: "🏥", police: "🚔", fire: "🚒", ambulance: "🚑", blood_bank: "🩸" }[t] || "📍";
}
function availLabel(a) {
  return { available: "Available 24/7", limited: "Limited Hours", unavailable: "Unavailable" }[a] || a;
}

// ===== GOOGLE MAPS DARK STYLE =====
function darkMapStyle() {
  return [
    { elementType: "geometry", stylers: [{ color: "#1d2c3e" }] },
    { elementType: "labels.text.stroke", stylers: [{ color: "#0d1b2a" }] },
    { elementType: "labels.text.fill", stylers: [{ color: "#8899aa" }] },
    { featureType: "road", elementType: "geometry", stylers: [{ color: "#263549" }] },
    { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#9ca5b3" }] },
    { featureType: "water", elementType: "geometry", stylers: [{ color: "#0d1b2a" }] },
    { featureType: "poi", stylers: [{ visibility: "off" }] },
    { featureType: "transit", stylers: [{ visibility: "off" }] },
  ];
}
