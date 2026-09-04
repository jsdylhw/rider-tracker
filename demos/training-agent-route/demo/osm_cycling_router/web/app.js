const map = L.map("map").setView([30.2420, 120.0960], 13);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap contributors",
}).addTo(map);

const statusNode = document.querySelector("#status");
const summaryNode = document.querySelector("#route-summary");
const placesNode = document.querySelector("#places");
const modeNode = document.querySelector("#planner-mode");
const routeHintNode = document.querySelector("#route-hint");
const destinationFieldNode = document.querySelector("#destination-field");
const loopDistanceFieldNode = document.querySelector("#loop-distance-field");
const loopCandidatesNode = document.querySelector("#loop-candidates");
const routeProbesNode = document.querySelector("#route-probes");
let endpoints = [];
let endpointLayer = L.layerGroup().addTo(map);
let routeLayer = L.geoJSON(null, { style: { color: "#1c7c4a", weight: 5, opacity: .9 } }).addTo(map);
let placeLayer = L.layerGroup().addTo(map);
// FeatureGroup keeps the same layer-management API as LayerGroup and also
// exposes getBounds(), needed to fit all generated loop candidates at once.
let loopLayer = L.featureGroup().addTo(map);
let loopRoutes = [];
let routeProbeLayer = L.featureGroup().addTo(map);
let routeProbeMarkerLayer = L.layerGroup().addTo(map);

function pointText(latlng) { return `${latlng.lat.toFixed(6)},${latlng.lng.toFixed(6)}`; }
function parsePoint(value) {
  const [lat, lon] = value.split(",").map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("坐标格式应为 纬度,经度");
  return L.latLng(lat, lon);
}
function setStatus(message, type = "") {
  statusNode.textContent = message;
  statusNode.className = `status ${type}`;
}
async function api(path) {
  const response = await fetch(path);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "本地服务请求失败");
  return payload;
}
function setEndpoints(next) {
  endpoints = next;
  endpointLayer.clearLayers();
  document.querySelector("#origin").value = endpoints[0] ? pointText(endpoints[0]) : "";
  document.querySelector("#destination").value = endpoints[1] ? pointText(endpoints[1]) : "";
  if (endpoints[0]) {
    L.marker(endpoints[0], { title: "起点" }).bindTooltip("起点").addTo(endpointLayer);
  }
  if (endpoints[1]) {
    L.marker(endpoints[1], { title: "终点" }).bindTooltip("终点").addTo(endpointLayer);
  }
}
function formatDistance(meters) { return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`; }
function formatDurationMilliseconds(milliseconds) {
  const minutes = Math.round(milliseconds / 60000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}小时${minutes % 60}分` : `${minutes} 分钟`;
}
function formatDurationSeconds(seconds) { return formatDurationMilliseconds(seconds * 1000); }
function clearLoopRoutes() {
  loopLayer.clearLayers();
  loopRoutes = [];
  loopCandidatesNode.replaceChildren();
}
function clearPointRoute() { routeLayer.clearLayers(); }
function clearRouteProbe() {
  routeProbeLayer.clearLayers();
  routeProbeMarkerLayer.clearLayers();
  routeProbesNode.replaceChildren();
}
function updatePlannerMode(clearSelection = false) {
  const isFreeLoop = modeNode.value === "free-loop";
  destinationFieldNode.hidden = isFreeLoop;
  loopDistanceFieldNode.hidden = !isFreeLoop;
  document.querySelector("#route-button").hidden = isFreeLoop;
  document.querySelector("#free-loop-button").hidden = !isFreeLoop;
  routeHintNode.textContent = isFreeLoop
    ? "在地图上点击一个起点，再生成多条本地自由环线。距离是目标值，结果会按距离误差和差异性筛选。"
    : "在地图上依次点击起点、终点；第三次点击会重设起点。";
  if (clearSelection) setEndpoints([]);
  clearPointRoute();
  clearLoopRoutes();
  summaryNode.textContent = "尚未计算";
}
async function calculateRoute() {
  try {
    const origin = parsePoint(document.querySelector("#origin").value);
    const destination = parsePoint(document.querySelector("#destination").value);
    setEndpoints([origin, destination]);
    setStatus("正在计算路线…");
    const profile = document.querySelector("#profile").value;
    const params = new URLSearchParams({ point: pointText(origin), profile, points_encoded: "false" });
    params.append("point", pointText(destination));
    const data = await api(`/api/route?${params}`);
    const path = data.paths[0];
    clearLoopRoutes();
    routeLayer.clearLayers().addData({ type: "LineString", coordinates: path.points.coordinates });
    map.fitBounds(routeLayer.getBounds(), { padding: [30, 30] });
    summaryNode.textContent = `${formatDistance(path.distance)} · ${formatDurationMilliseconds(path.time)}${path.ascend ? ` · 爬升 ${Math.round(path.ascend)} m` : ""}`;
    setStatus("本地路由已完成", "ready");
  } catch (error) {
    summaryNode.textContent = error.message;
    setStatus("路线请求失败", "error");
  }
}
function selectLoop(index) {
  loopRoutes.forEach(({ layer }, candidateIndex) => {
    layer.setStyle(candidateIndex === index
      ? { color: "#f5a623", weight: 7, opacity: 1 }
      : { color: "#4e9e71", weight: 4, opacity: .55 });
  });
  const candidate = loopRoutes[index].candidate;
  summaryNode.textContent = `候选 ${index + 1} · ${formatDistance(candidate.distance_m)} · ${formatDurationSeconds(candidate.duration_s)} · 距离误差 ${candidate.distance_error_pct}%${candidate.ascend_m ? ` · 爬升 ${Math.round(candidate.ascend_m)} m` : ""}`;
}
function renderFreeLoops(candidates) {
  clearLoopRoutes();
  candidates.forEach((candidate, index) => {
    const layer = L.geoJSON(candidate.geometry, { style: { color: "#4e9e71", weight: 4, opacity: .55 } }).addTo(loopLayer);
    layer.on("click", () => selectLoop(index));
    loopRoutes.push({ candidate, layer });
    const item = document.createElement("li");
    item.className = "loop-candidate";
    item.innerHTML = `<strong>候选 ${index + 1}</strong><small>${formatDistance(candidate.distance_m)} · ${formatDurationSeconds(candidate.duration_s)} · 误差 ${candidate.distance_error_pct}%</small>`;
    item.addEventListener("click", () => selectLoop(index));
    loopCandidatesNode.append(item);
  });
  if (loopRoutes.length) {
    map.fitBounds(loopLayer.getBounds(), { padding: [30, 30] });
    selectLoop(0);
  }
}
async function calculateFreeLoop() {
  try {
    const origin = parsePoint(document.querySelector("#origin").value);
    const distanceKm = Number(document.querySelector("#loop-distance").value);
    if (!Number.isFinite(distanceKm) || distanceKm < 1 || distanceKm > 300) throw new Error("目标距离应在 1–300 km 之间");
    setEndpoints([origin]);
    clearPointRoute();
    setStatus("正在从本地路网生成自由环线…");
    const data = await api(`/api/free-loop?${new URLSearchParams({
      point: pointText(origin), distance_km: String(distanceKm), profile: document.querySelector("#profile").value, count: "3",
    })}`);
    if (!data.candidates.length) throw new Error(`未找到符合 ±${data.distance_tolerance_pct}% 距离容差的环线`);
    renderFreeLoops(data.candidates);
    setStatus(`本地生成 ${data.count} 条自由环线（尝试 ${data.attempts} 个 seed）`, "ready");
  } catch (error) {
    clearLoopRoutes();
    summaryNode.textContent = error.message;
    setStatus("自由环线生成失败", "error");
  }
}
function showPlaces(places) {
  placesNode.replaceChildren();
  placeLayer.clearLayers();
  if (!places.length) {
    placesNode.textContent = "没有匹配的 OSM 风景点。";
    return;
  }
  for (const place of places) {
    const marker = L.circleMarker([place.lat, place.lon], { radius: 7, color: "#d06b31", fillOpacity: .85 })
      .bindPopup(`<b>${place.name}</b><br>${place.category}`)
      .addTo(placeLayer);
    const item = document.createElement("li");
    const distance = place.distance_m == null ? "" : ` · ${formatDistance(place.distance_m)}`;
    item.innerHTML = `<strong>${place.name}</strong><small>${place.category}${distance}</small>`;
    item.addEventListener("click", () => { map.setView([place.lat, place.lon], 15); marker.openPopup(); });
    placesNode.append(item);
  }
}
async function searchPlaces() {
  try {
    const query = document.querySelector("#search-query").value.trim();
    if (!query) throw new Error("请输入地点名称");
    const center = map.getCenter();
    const data = await api(`/api/places/search?${new URLSearchParams({ q: query, near: pointText(center) })}`);
    showPlaces(data.places);
    setStatus(`找到 ${data.places.length} 个本地风景点`, "ready");
  } catch (error) { setStatus(error.message, "error"); }
}
async function nearbyPlaces() {
  try {
    const data = await api(`/api/places/nearby?${new URLSearchParams({ point: pointText(map.getCenter()), radius_m: "5000" })}`);
    showPlaces(data.places);
    setStatus(`找到 ${data.places.length} 个附近风景点`, "ready");
  } catch (error) { setStatus(error.message, "error"); }
}
function renderRouteProbe(probe) {
  clearRouteProbe();
  for (const feature of probe.features) {
    const isSegment = feature.properties?.kind === "strava_segment";
    const isLocalRebuild = feature.properties?.kind === "local_graphhopper_rebuild";
    const isCandidate = feature.properties?.kind === "graphhopper_candidate";
    const isHandoffGap = feature.properties?.kind === "strava_handoff_gap";
    const layer = L.geoJSON(feature, {
      style: { color: feature.properties?.color || (isSegment ? "#d7438d" : isHandoffGap ? "#e0a62b" : "#2d7dd2"), weight: isSegment ? 6 : 4, opacity: .88, dashArray: isHandoffGap ? "7 7" : undefined },
    }).addTo(routeProbeLayer);
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = `${isSegment ? "Strava 路段" : isHandoffGap ? "待核验接缝" : isLocalRebuild ? "本地重建" : isCandidate ? "连接候选" : "连接"} · ${feature.properties?.name || "未命名路段"}`;
    const detail = document.createElement("small");
    detail.textContent = `${formatDistance(feature.properties?.distance_m || 0)}${feature.properties?.handoff_gap_m ? " · 非路网接缝，需核验" : ""}${feature.properties?.local_distance_m ? ` · 区域 ${formatDistance(feature.properties.local_distance_m)}` : ""}${feature.properties?.local_retrace_ratio != null ? ` · 区域重复 ${(Number(feature.properties.local_retrace_ratio) * 100).toFixed(1)}%` : ""}${feature.properties?.reverse_overlap_m ? ` · 反向重叠 ${formatDistance(feature.properties.reverse_overlap_m)}` : ""}${feature.properties?.ascend_m ? ` · 爬升 ${Math.round(feature.properties.ascend_m)} m` : ""}`;
    item.append(title, detail);
    item.addEventListener("click", () => {
      if (isCandidate) {
        routeProbeLayer.eachLayer((otherLayer) => {
          const otherKind = otherLayer.feature?.properties?.kind;
          const selected = otherLayer === layer;
          otherLayer.setStyle({
            opacity: selected ? 1 : otherKind === "strava_segment" ? .7 : .12,
            weight: selected ? 7 : otherKind === "strava_segment" ? 6 : 3,
          });
        });
      }
      map.fitBounds(layer.getBounds(), { padding: [30, 30] });
    });
    routeProbesNode.append(item);
  }
  const start = probe.metadata?.start_latlng;
  const end = probe.metadata?.end_latlng;
  if (Array.isArray(start) && start.length === 2 && Array.isArray(end) && end.length === 2) {
    const closure = Number(probe.metadata?.closure_gap_m || 0);
    L.circleMarker(start, { radius: 9, color: "#f7d154", fillColor: "#1e9b58", fillOpacity: .95, weight: 3 })
      .bindTooltip(`起终点 · 闭合差 ${Math.round(closure)} m`, { permanent: true, direction: "top" })
      .addTo(routeProbeMarkerLayer);
  }
  if (routeProbeLayer.getLayers().length) map.fitBounds(routeProbeLayer.getBounds(), { padding: [30, 30] });
}
async function showRouteProbe(name, loadingText, fallbackName, readyText) {
  try {
    setStatus(loadingText);
    const probe = await api(`/api/route-probes/${name}`);
    renderRouteProbe(probe);
    const meta = probe.metadata || {};
    const distance = meta.total_distance_m || meta.local_distance_m || meta.source_distance_m || 0;
    const candidateCount = Number(meta.candidate_count || 0);
    const candidateMinDistance = Number(meta.candidate_min_distance_m || 0);
    const candidateMaxDistance = Number(meta.candidate_max_distance_m || 0);
    const routeSummary = candidateCount > 1 && candidateMinDistance && candidateMaxDistance
      ? `${candidateCount} 条候选 · ${formatDistance(candidateMinDistance)}–${formatDistance(candidateMaxDistance)}`
      : candidateCount > 1
        ? `${candidateCount} 条候选 · 目标 ${formatDistance(meta.target_distance_m || distance)}`
        : formatDistance(distance);
    summaryNode.textContent = `${meta.name || fallbackName} · ${routeSummary}${meta.known_segment_ascent_m ? ` · 已知主爬 ${Math.round(meta.known_segment_ascent_m)} m` : meta.source_ascent_m ? ` · 已知爬升 ${Math.round(meta.source_ascent_m)} m` : ""}${meta.closure_gap_m != null ? ` · 闭合差 ${Math.round(meta.closure_gap_m)} m` : meta.local_closure_gap_m != null ? ` · 闭合差 ${Math.round(meta.local_closure_gap_m)} m` : ""}`;
    setStatus(readyText, "ready");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function showHangzhouNorthwestProbe() {
  return showRouteProbe("hangzhou-nw-climb-loop", "正在读取本地杭州西北爬坡环线探针…", "杭州西北爬坡环线", "已叠加 Strava 主爬与本地连接段");
}

function showHangzhouNorthwestReversibleProbe() {
  return showRouteProbe("hangzhou-nw-reversible-loop", "正在读取杭州西北可反向闭环探针…", "杭州西北可反向闭环", "已叠加允许反向后的主爬与本地连接段");
}

function showJingshanTownProbe() {
  return showRouteProbe("jingshan-town-reversible-loop", "正在读取径山镇出发闭环探针…", "径山镇出发主爬闭环", "已叠加径山镇起终点、可反向主爬与本地连接段");
}

function showHangzhouRetraceProbe() {
  return showRouteProbe("hangzhou-retrace-candidates", "正在读取王位山连接候选…", "王位山连接候选", "已叠加主爬和 GraphHopper 回头路惩罚候选");
}

map.on("click", (event) => {
  if (modeNode.value === "free-loop") {
    setEndpoints([event.latlng]);
    clearPointRoute();
    clearLoopRoutes();
  } else {
    setEndpoints(endpoints.length >= 2 ? [event.latlng] : [...endpoints, event.latlng]);
    clearLoopRoutes();
  }
});
document.querySelector("#route-button").addEventListener("click", calculateRoute);
document.querySelector("#free-loop-button").addEventListener("click", calculateFreeLoop);
modeNode.addEventListener("change", () => updatePlannerMode(true));
document.querySelector("#search-form").addEventListener("submit", (event) => { event.preventDefault(); searchPlaces(); });
document.querySelector("#nearby-button").addEventListener("click", nearbyPlaces);
document.querySelector("#show-hangzhou-nw-probe").addEventListener("click", showHangzhouNorthwestProbe);
document.querySelector("#show-hangzhou-nw-reversible-probe").addEventListener("click", showHangzhouNorthwestReversibleProbe);
document.querySelector("#show-jingshan-town-probe").addEventListener("click", showJingshanTownProbe);
document.querySelector("#show-hangzhou-retrace-probe").addEventListener("click", showHangzhouRetraceProbe);
updatePlannerMode();

// Local experiments can be opened directly without adding a permanent button
// for every ignored route-probe GeoJSON file.
const requestedProbe = new URLSearchParams(window.location.search).get("probe");
const validRequestedProbe = requestedProbe && /^[a-z0-9][a-z0-9_-]*$/.test(requestedProbe);
api("/health").then(() => {
  setStatus("本地服务已就绪", "ready");
  if (validRequestedProbe) {
    return showRouteProbe(
      requestedProbe,
      "正在读取本地路线探针…",
      "本地路线探针",
      "已叠加本地路线探针",
    );
  }
  return null;
}).catch(() => setStatus("本地服务不可用", "error"));
