const DEFAULT_CENTER = [52.3676, 4.9041];
const DEFAULT_ZOOM = 13;
const DEFAULT_RADIUS_KM = 1;
const MAX_RESULTS = 160;
const APP_VERSION = "2026.05.27.8";
const OCM_API_KEY = "";
const OVERPASS_ENDPOINTS = [
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

const statusEl = document.getElementById("status");
const searchForm = document.getElementById("search-form");
const locationInput = document.getElementById("location-input");
const radiusSelect = document.getElementById("radius-select");
const useLocationBtn = document.getElementById("use-location-btn");
const refreshBtn = document.getElementById("refresh-btn");
const resultsList = document.getElementById("results-list");
const installBtn = document.getElementById("install-btn");
const openChromeBtn = document.getElementById("open-chrome-btn");
const qrBtn = document.getElementById("qr-btn");
const versionBadge = document.getElementById("version-badge");
const qrDialog = document.getElementById("qr-dialog");
const qrImage = document.getElementById("qr-image");
const qrUrlEl = document.getElementById("qr-url");
const closeQrBtn = document.getElementById("close-qr-btn");

const map = L.map("map", { zoomControl: false }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
L.control.zoom({ position: "bottomright" }).addTo(map);

const modernTiles = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 20,
    attribution: "Tiles &copy; Esri",
  }
);

const cleanTiles = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
  maxZoom: 20,
  subdomains: "abcd",
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; CARTO',
});

modernTiles.addTo(map);
L.control
  .layers(
    {
      "Modern Streets": modernTiles,
      "Clean Map": cleanTiles,
    },
    null,
    { position: "topright", collapsed: true }
  )
  .addTo(map);

const chargeLayer = L.layerGroup().addTo(map);
const centerMarker = L.circleMarker(DEFAULT_CENTER, {
  radius: 7,
  color: "#0f766e",
  fillColor: "#14b8a6",
  fillOpacity: 0.95,
  weight: 2,
}).addTo(map);

let userLocationMarker = null;
let searchLocationMarker = null;
let deferredInstallPrompt = null;

const state = {
  lastCenter: { lat: DEFAULT_CENTER[0], lon: DEFAULT_CENTER[1] },
  lastRadiusKm: DEFAULT_RADIUS_KM,
  points: [],
  publicUsageTypeIds: null,
  loading: false,
  dataSource: "osm",
};

function setStatus(message) {
  statusEl.textContent = message;
}

function hasOcmApiKey() {
  return typeof OCM_API_KEY === "string" && OCM_API_KEY.trim().length > 0;
}

function isStandaloneMode() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

function isChromeAndroidBrowser() {
  const ua = navigator.userAgent || "";
  return /Android/i.test(ua) && /Chrome/i.test(ua);
}

function updateInstallButton() {
  if (!installBtn) return;
  if (isStandaloneMode()) {
    installBtn.hidden = true;
    installBtn.disabled = true;
    return;
  }
  installBtn.hidden = false;
  installBtn.disabled = false;
}

function focusMapByRadius(lat, lon, radiusKm) {
  const radiusMeters = Math.max(500, Math.round(radiusKm * 1000));
  const bounds = L.circle([lat, lon], { radius: radiusMeters }).getBounds();
  map.fitBounds(bounds, {
    padding: [28, 28],
    maxZoom: radiusKm <= 1 ? 16 : 15,
  });
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function kmDistance(fromLat, fromLon, toLat, toLon) {
  const toRad = (value) => (value * Math.PI) / 180;
  const r = 6371;
  const dLat = toRad(toLat - fromLat);
  const dLon = toRad(toLon - fromLon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(fromLat)) * Math.cos(toRad(toLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getColorForStatus(statusText) {
  const text = (statusText || "").toLowerCase();
  if (
    text.includes("in use") ||
    text.includes("occupied") ||
    text.includes("busy") ||
    text.includes("unavailable")
  ) {
    return "#dc2626";
  }
  if (
    text.includes("free") ||
    text.includes("available") ||
    text.includes("operational") ||
    text.includes("open")
  ) {
    return "#16a34a";
  }
  if (text.includes("planned") || text.includes("future")) return "#f59e0b";
  return "#16a34a";
}

function buildPointPopup(point) {
  const title = point.title || "Charging location";
  const address = point.address || "Address unknown";
  const status = point.status || "Status unknown";
  const operator = point.operator || "Operator unknown";
  const usage = point.usage || "Usage unknown";
  const connectorText = point.connectorSummary || "Connector details unavailable";
  return `
    <div class="popup">
      <strong>${escapeHtml(title)}</strong><br>
      <span>${escapeHtml(address)}</span><br>
      <span>Status: ${escapeHtml(status)}</span><br>
      <span>Usage: ${escapeHtml(usage)}</span><br>
      <span>Operator: ${escapeHtml(operator)}</span><br>
      <span>Connectors: ${escapeHtml(connectorText)}</span>
    </div>
  `;
}

function normalizeConnectorText(connections) {
  if (!Array.isArray(connections) || connections.length === 0) return "";
  return connections
    .map((connection) => {
      const type =
        connection?.ConnectionType?.Title ||
        connection?.ConnectionTypeTitle ||
        connection?.ConnectionTypeID ||
        "Connector";
      const power = connection?.PowerKW ? `${connection.PowerKW} kW` : "";
      const qty = connection?.Quantity ? `x${connection.Quantity}` : "";
      return [type, power, qty].filter(Boolean).join(" ");
    })
    .slice(0, 4)
    .join(", ");
}

function isPublicPoint(point) {
  if (!point) return false;
  const usageId = point.UsageTypeID;
  const usageTitle = point?.UsageType?.Title || point?.usage || "";

  if (Array.isArray(state.publicUsageTypeIds) && state.publicUsageTypeIds.length > 0) {
    if (usageId != null) return state.publicUsageTypeIds.includes(usageId);
  }

  const title = usageTitle.toLowerCase();
  if (title.includes("private")) return false;
  if (title.includes("public")) return true;

  return true;
}

async function fetchReferenceData() {
  if (!hasOcmApiKey()) return;
  try {
    const response = await fetchJsonWithTimeout(
      "https://api.openchargemap.io/v3/referencedata/?output=json",
      {},
      9000
    );
    if (!response.ok) return;
    const data = await response.json();
    const usageTypes = Array.isArray(data?.UsageTypes) ? data.UsageTypes : [];
    const publicIds = usageTypes
      .filter((item) => /public/i.test(item?.Title || "") && !/private/i.test(item?.Title || ""))
      .map((item) => item.ID)
      .filter((id) => Number.isInteger(id));
    if (publicIds.length > 0) {
      state.publicUsageTypeIds = publicIds;
    }
  } catch (_error) {
    // Non-blocking: app still works with fallback filtering.
  }
}

async function fetchOpenChargeMapPoints(lat, lon, radiusKm) {
  if (!hasOcmApiKey()) return [];
  const params = new URLSearchParams({
    output: "json",
    latitude: String(lat),
    longitude: String(lon),
    distance: String(radiusKm),
    distanceunit: "KM",
    maxresults: String(MAX_RESULTS),
    compact: "true",
    verbose: "false",
    opendata: "true",
    key: OCM_API_KEY.trim(),
  });

  const endpoint = `https://api.openchargemap.io/v3/poi/?${params.toString()}`;
  const response = await fetchJsonWithTimeout(
    endpoint,
    {
      headers: {
        "X-API-Key": OCM_API_KEY.trim(),
      },
    },
    12000
  );
  if (!response.ok) {
    throw new Error(`Open Charge Map request failed (${response.status})`);
  }

  const raw = await response.json();
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((item) => item?.AddressInfo?.Latitude && item?.AddressInfo?.Longitude)
    .filter(isPublicPoint)
    .map((item) => ({
      source: "ocm",
      lat: item.AddressInfo.Latitude,
      lon: item.AddressInfo.Longitude,
      title: item.AddressInfo.Title || "Charging location",
      address: [
        item.AddressInfo.AddressLine1,
        item.AddressInfo.Town,
        item.AddressInfo.StateOrProvince,
      ]
        .filter(Boolean)
        .join(", "),
      status: item?.StatusType?.Title || "Status unknown",
      usage: item?.UsageType?.Title || "Public/unknown",
      operator: item?.OperatorInfo?.Title || "Unknown operator",
      connectorSummary: normalizeConnectorText(item?.Connections),
      distanceKm: kmDistance(lat, lon, item.AddressInfo.Latitude, item.AddressInfo.Longitude),
    }));
}

async function fetchOverpassFallback(lat, lon, radiusKm) {
  const radiusMeters = Math.max(500, Math.round(radiusKm * 1000));
  const query = `
[out:json][timeout:20];
(
  node["amenity"="charging_station"](around:${radiusMeters},${lat},${lon});
  way["amenity"="charging_station"](around:${radiusMeters},${lat},${lon});
  relation["amenity"="charging_station"](around:${radiusMeters},${lat},${lon});
);
out center;
`;
  const errors = [];

  for (const endpoint of OVERPASS_ENDPOINTS) {
    const url = `${endpoint}?data=${encodeURIComponent(query.trim())}`;
    try {
      const response = await fetchJsonWithTimeout(
        url,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
          },
        },
        12000
      );
      if (!response.ok) {
        errors.push(`${endpoint} (${response.status})`);
        continue;
      }

      const data = await response.json();
      const elements = Array.isArray(data?.elements) ? data.elements : [];
      const mapped = elements
        .map((item) => {
          const latValue = item.lat ?? item.center?.lat;
          const lonValue = item.lon ?? item.center?.lon;
          if (typeof latValue !== "number" || typeof lonValue !== "number") return null;
          const tags = item.tags || {};
          return {
            source: "overpass",
            lat: latValue,
            lon: lonValue,
            title: tags.name || "Charging location",
            address: [tags["addr:street"], tags["addr:housenumber"], tags["addr:city"]]
              .filter(Boolean)
              .join(" "),
            status: tags.operational_status || "Status unknown",
            usage: tags.access === "private" ? "Private" : "Public/unknown",
            operator: tags.operator || "Unknown operator",
            connectorSummary: tags.socket || tags.socket_type2 || "",
            distanceKm: kmDistance(lat, lon, latValue, lonValue),
          };
        })
        .filter(Boolean)
        .filter((point) => point.usage !== "Private");

      if (mapped.length > 0) return mapped;
      errors.push(`${endpoint} (no results)`);
    } catch (error) {
      errors.push(`${endpoint} (${error.message})`);
    }
  }

  throw new Error(`Overpass unavailable: ${errors.join("; ")}`);
}

function getBoundingBox(lat, lon, radiusKm) {
  const latDelta = radiusKm / 111.32;
  const lonDelta = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  return {
    left: lon - lonDelta,
    right: lon + lonDelta,
    top: lat + latDelta,
    bottom: lat - latDelta,
  };
}

async function fetchNominatimChargingPoints(lat, lon, radiusKm) {
  const box = getBoundingBox(lat, lon, radiusKm);
  const params = new URLSearchParams({
    q: "[charging station]",
    format: "jsonv2",
    bounded: "1",
    limit: "50",
    viewbox: `${box.left},${box.top},${box.right},${box.bottom}`,
  });

  const response = await fetchJsonWithTimeout(
    `https://nominatim.openstreetmap.org/search?${params.toString()}`,
    {
      headers: {
        Accept: "application/json",
      },
    },
    12000
  );

  if (!response.ok) {
    throw new Error(`Nominatim charging search failed (${response.status})`);
  }

  const data = await response.json();
  const rows = Array.isArray(data) ? data : [];
  return rows
    .map((item) => {
      const latValue = Number(item.lat);
      const lonValue = Number(item.lon);
      if (!Number.isFinite(latValue) || !Number.isFinite(lonValue)) return null;
      return {
        source: "nominatim",
        lat: latValue,
        lon: lonValue,
        title: item.display_name?.split(",")[0] || "Charging location",
        address: item.display_name || "Address unknown",
        status: "Status unknown",
        usage: "Public/unknown",
        operator: "Unknown operator",
        connectorSummary: "",
        distanceKm: kmDistance(lat, lon, latValue, lonValue),
      };
    })
    .filter(Boolean);
}

function clearPoints() {
  chargeLayer.clearLayers();
  resultsList.innerHTML = "";
}

function renderPoints(points) {
  clearPoints();

  if (points.length === 0) {
    resultsList.innerHTML = "<li>No charge points found for this area.</li>";
    return;
  }

  for (const point of points) {
    const marker = L.circleMarker([point.lat, point.lon], {
      radius: 8,
      color: "#0f172a",
      weight: 1.2,
      fillOpacity: 0.92,
      fillColor: getColorForStatus(point.status),
    }).addTo(chargeLayer);
    marker.bindPopup(buildPointPopup(point));

    const row = document.createElement("li");
    row.className = "result-item";
    row.innerHTML = `
      <button type="button" class="result-btn">
        <strong>${escapeHtml(point.title)}</strong>
        <span>${escapeHtml(point.address || "Address unknown")}</span>
        <span>${escapeHtml(point.status)} - ${point.distanceKm.toFixed(1)} km</span>
      </button>
    `;
    row.querySelector("button").addEventListener("click", () => {
      map.setView([point.lat, point.lon], 16);
      marker.openPopup();
    });
    resultsList.appendChild(row);
  }
}

async function refreshPoints(lat, lon, radiusKm) {
  if (state.loading) return;
  state.loading = true;
  setStatus("Loading public charge points...");
  centerMarker.setLatLng([lat, lon]);

  let points = [];
  try {
    points = await fetchOverpassFallback(lat, lon, radiusKm);
    state.dataSource = "osm";
    if (points.length === 0) {
      setStatus("No points from Overpass source. Trying Nominatim...");
      points = await fetchNominatimChargingPoints(lat, lon, radiusKm);
      state.dataSource = "nominatim";
    }
    if (points.length === 0 && hasOcmApiKey()) {
      setStatus("No points from OpenStreetMap source. Trying Open Charge Map...");
      points = await fetchOpenChargeMapPoints(lat, lon, radiusKm);
      state.dataSource = "ocm";
    }
    points.sort((a, b) => a.distanceKm - b.distanceKm);
    state.points = points;
    renderPoints(points);
    const sourceLabel =
      state.dataSource === "ocm"
        ? "Open Charge Map"
        : state.dataSource === "nominatim"
          ? "OpenStreetMap (Nominatim)"
          : "OpenStreetMap (Overpass)";
    setStatus(`Showing ${points.length} public points within ~${radiusKm} km. Source: ${sourceLabel}.`);
  } catch (error) {
    clearPoints();
    setStatus(
      `Could not load data (${error.message}). If this keeps happening, the network may be blocking map/data services.`
    );
  } finally {
    state.loading = false;
  }
}

async function searchLocation(query) {
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    addressdetails: "1",
    limit: "1",
  });

  const response = await fetchJsonWithTimeout(
    `https://nominatim.openstreetmap.org/search?${params.toString()}`,
    {},
    10000
  );
  if (!response.ok) {
    throw new Error(`Location search failed (${response.status})`);
  }
  const results = await response.json();
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error("Location not found");
  }
  const first = results[0];
  return {
    lat: Number(first.lat),
    lon: Number(first.lon),
    label: first.display_name || query,
  };
}

function setMapTarget(lat, lon, radiusKm = DEFAULT_RADIUS_KM) {
  focusMapByRadius(lat, lon, radiusKm);
  state.lastCenter = { lat, lon };
  state.lastRadiusKm = radiusKm;
  centerMarker.setLatLng([lat, lon]);
}

function showQr() {
  const currentUrl = window.location.href.split("#")[0];
  const encoded = encodeURIComponent(currentUrl);
  const qrSource = `https://api.qrserver.com/v1/create-qr-code/?size=360x360&data=${encoded}`;
  qrImage.src = qrSource;
  qrUrlEl.textContent = currentUrl;
  if (typeof qrDialog.showModal === "function") {
    qrDialog.showModal();
  } else {
    alert(`Open this link on your phone:\n${currentUrl}`);
  }
}

function closeQr() {
  if (typeof qrDialog.close === "function") qrDialog.close();
}

async function useDeviceLocation() {
  if (!navigator.geolocation) {
    setStatus("Geolocation is not supported on this browser.");
    return false;
  }

  setStatus("Getting your location...");
  return await new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const lat = position.coords.latitude;
        const lon = position.coords.longitude;
        const radiusKm = Number(radiusSelect.value) || DEFAULT_RADIUS_KM;
        state.lastCenter = { lat, lon };
        setMapTarget(lat, lon, radiusKm);
        if (!userLocationMarker) {
          userLocationMarker = L.circle([lat, lon], {
            radius: 20,
            color: "#0ea5e9",
            fillColor: "#7dd3fc",
            fillOpacity: 0.25,
            weight: 2,
          }).addTo(map);
        } else {
          userLocationMarker.setLatLng([lat, lon]);
        }

        state.lastRadiusKm = radiusKm;
        await refreshPoints(lat, lon, radiusKm);
        resolve(true);
      },
      (error) => {
        if (error && error.code === 1) {
          setStatus("Location blocked. In Android settings, allow Location permission for EV Charge Finder.");
        } else {
          setStatus(`Location permission failed: ${error.message}`);
        }
        resolve(false);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 60000,
      }
    );
  });
}

searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = locationInput.value.trim();
  const radiusKm = Number(radiusSelect.value) || DEFAULT_RADIUS_KM;
  if (!query) return;

  setStatus("Searching location...");
  try {
    const found = await searchLocation(query);
    setMapTarget(found.lat, found.lon, radiusKm);
    state.lastRadiusKm = radiusKm;
    state.lastCenter = { lat: found.lat, lon: found.lon };
    if (!searchLocationMarker) {
      searchLocationMarker = L.marker([found.lat, found.lon]).addTo(map);
    } else {
      searchLocationMarker.setLatLng([found.lat, found.lon]);
    }
    searchLocationMarker.bindPopup(`Search location: ${escapeHtml(found.label)}`).openPopup();
    await refreshPoints(found.lat, found.lon, radiusKm);
  } catch (error) {
    setStatus(error.message);
  }
});

useLocationBtn.addEventListener("click", () => {
  void useDeviceLocation();
});

refreshBtn.addEventListener("click", () => {
  const radiusKm = Number(radiusSelect.value) || DEFAULT_RADIUS_KM;
  const center = map.getCenter();
  state.lastCenter = { lat: center.lat, lon: center.lng };
  state.lastRadiusKm = radiusKm;
  void refreshPoints(center.lat, center.lng, radiusKm);
});

radiusSelect.addEventListener("change", () => {
  const radiusKm = Number(radiusSelect.value) || DEFAULT_RADIUS_KM;
  const center = map.getCenter();
  focusMapByRadius(center.lat, center.lng, radiusKm);
});

qrBtn.addEventListener("click", showQr);
closeQrBtn.addEventListener("click", closeQr);
installBtn.addEventListener("click", async () => {
  if (!deferredInstallPrompt || typeof deferredInstallPrompt.prompt !== "function") {
    setStatus("Use Chrome menu -> Add to Home screen (or Install app).");
    return;
  }
  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  updateInstallButton();
  if (choice?.outcome === "accepted") {
    setStatus("Install accepted. Check your home screen for the app icon.");
  } else {
    setStatus("Install canceled. You can still use menu -> Add to Home screen.");
  }
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  updateInstallButton();
  setStatus("Install is ready. Tap Install app.");
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  updateInstallButton();
  setStatus("App installed. Open it from your home screen.");
});

window.addEventListener("load", () => {
  if (isStandaloneMode()) return;
  if (!isChromeAndroidBrowser()) {
    setStatus("Open this page in Google Chrome to install as an app.");
    if (openChromeBtn) {
      openChromeBtn.hidden = false;
      openChromeBtn.disabled = false;
    }
  }
});

if (openChromeBtn) {
  openChromeBtn.addEventListener("click", () => {
    const current = window.location.href;
    const cleanUrl = current.replace(/^https?:\/\//i, "");
    const intentUrl = `intent://${cleanUrl}#Intent;scheme=https;package=com.android.chrome;end`;
    window.location.href = intentUrl;
  });
}

map.on("moveend", () => {
  const center = map.getCenter();
  state.lastCenter = { lat: center.lat, lon: center.lng };
  centerMarker.setLatLng([center.lat, center.lng]);
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {
      // Service worker is optional.
    });
  });
}

async function init() {
  if (versionBadge) versionBadge.textContent = `v${APP_VERSION}`;
  if (radiusSelect) radiusSelect.value = String(DEFAULT_RADIUS_KM);
  updateInstallButton();
  setStatus(`Loading app (v${APP_VERSION})...`);
  await fetchReferenceData();
  const gotLocation = await useDeviceLocation();
  if (!gotLocation) {
    await refreshPoints(state.lastCenter.lat, state.lastCenter.lon, state.lastRadiusKm);
  }
}

void init();
