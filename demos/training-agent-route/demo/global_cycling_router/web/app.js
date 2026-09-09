const state = { origin: null, destination: null, routeLayer: null, markers: {} };
const map = L.map("map", { zoomControl: true }).setView([45, 10], 4);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const elements = {
  status: document.querySelector("#status"),
  routeButton: document.querySelector("#route-button"),
  routeSummary: document.querySelector("#route-summary"),
  origin: groupElements("origin"),
  destination: groupElements("destination"),
};

function groupElements(kind) {
  return {
    input: document.querySelector(`#${kind}-query`),
    search: document.querySelector(`#${kind}-search`),
    selected: document.querySelector(`#${kind}-selected`),
    results: document.querySelector(`#${kind}-results`),
  };
}

function setStatus(message, type = "") {
  elements.status.textContent = message;
  elements.status.className = `status ${type}`;
}

async function api(path) {
  const response = await fetch(path);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "本地路线服务请求失败");
  return payload;
}

async function searchPlaces(kind) {
  const group = elements[kind];
  const query = group.input.value.trim();
  if (!query) {
    setStatus("请输入地点关键词。", "error");
    return;
  }
  group.search.disabled = true;
  group.results.replaceChildren();
  setStatus(`正在搜索${kind === "origin" ? "起点" : "终点"}……`);
  try {
    const payload = await api(`/api/places?${new URLSearchParams({ q: query, limit: "6" })}`);
    renderResults(kind, payload.places || []);
    setStatus(payload.places?.length ? "请选择一个搜索结果。" : "没有找到带坐标的地点。", payload.places?.length ? "" : "error");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    group.search.disabled = false;
  }
}

function renderResults(kind, places) {
  const list = elements[kind].results;
  list.replaceChildren();
  places.forEach((place) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "place-result";
    const name = document.createElement("strong");
    name.textContent = place.name;
    const address = document.createElement("small");
    address.textContent = place.address || `${place.location.latitude}, ${place.location.longitude}`;
    button.append(name, address);
    button.addEventListener("click", () => selectPlace(kind, place));
    item.append(button);
    list.append(item);
  });
}

function selectPlace(kind, place) {
  state[kind] = place;
  const location = place.location;
  elements[kind].selected.textContent = `${place.name} · ${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`;
  elements[kind].results.replaceChildren();
  if (state.markers[kind]) map.removeLayer(state.markers[kind]);
  state.markers[kind] = L.marker([location.latitude, location.longitude])
    .addTo(map)
    .bindPopup(`${kind === "origin" ? "起点" : "终点"}：${escapeText(place.name)}`);
  elements.routeButton.disabled = !(state.origin && state.destination);
  clearRoute();
  const markers = Object.values(state.markers);
  if (markers.length === 1) map.setView(markers[0].getLatLng(), 13);
  else map.fitBounds(L.featureGroup(markers).getBounds().pad(0.25));
  setStatus("地点已选择。", "ready");
}

async function generateRoute() {
  if (!state.origin || !state.destination) return;
  elements.routeButton.disabled = true;
  setStatus("正在调用 Google Routes 生成路线……");
  clearRoute();
  const points = [state.origin, state.destination].map((place) =>
    `${place.location.latitude},${place.location.longitude}`
  );
  const params = new URLSearchParams();
  points.forEach((point) => params.append("point", point));
  const sharedCountry = state.origin.country_code && state.origin.country_code === state.destination.country_code
    ? state.origin.country_code
    : "";
  if (sharedCountry) params.set("country", sharedCountry);
  try {
    const route = await api(`/api/route?${params}`);
    state.routeLayer = L.geoJSON(route.geometry, { style: { color: "#087f6c", weight: 6, opacity: 0.9 } }).addTo(map);
    map.fitBounds(state.routeLayer.getBounds().pad(0.08));
    elements.routeSummary.hidden = false;
    const modeLabel = route.travel_mode === "DRIVE" ? "Google 驾车降级路线" : "Google 骑行路线";
    elements.routeSummary.textContent = `${formatDistance(route.distance_m)} · ${formatDuration(route.duration_s)} · ${modeLabel}`;
    if (route.warning) elements.routeSummary.textContent += ` · ${route.warning}`;
    setStatus("国外骑行路线已生成。", "ready");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    elements.routeButton.disabled = !(state.origin && state.destination);
  }
}

function clearRoute() {
  if (state.routeLayer) map.removeLayer(state.routeLayer);
  state.routeLayer = null;
  elements.routeSummary.hidden = true;
}

function formatDistance(value) {
  return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value)} m`;
}

function formatDuration(value) {
  const minutes = Math.round(value / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes} 分钟`;
}

function escapeText(value) {
  const node = document.createElement("span");
  node.textContent = String(value || "");
  return node.innerHTML;
}

["origin", "destination"].forEach((kind) => {
  elements[kind].search.addEventListener("click", () => searchPlaces(kind));
  elements[kind].input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") searchPlaces(kind);
  });
});
elements.routeButton.addEventListener("click", generateRoute);

api("/health")
  .then(() => setStatus("本地服务已就绪，请搜索国外地点。", "ready"))
  .catch((error) => setStatus(error.message, "error"));
