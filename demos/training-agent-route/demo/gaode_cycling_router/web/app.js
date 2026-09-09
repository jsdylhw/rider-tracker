const statusNode = document.querySelector("#status");
const summaryNode = document.querySelector("#route-summary");
const probeItemsNode = document.querySelector("#probe-items");
const map = new AMap.Map("map", { zoom: 13, center: [118.789980, 32.023248], viewMode: "2D" });
map.addControl(new AMap.ToolBar());
map.addControl(new AMap.Scale());

let points = [];
let markerOverlays = [];
let routeOverlays = [];

function setStatus(message, type = "") { statusNode.textContent = message; statusNode.className = `status ${type}`; }
function formatDistance(meters) { return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`; }
function formatDuration(seconds) { const minutes = Math.round(seconds / 60); return minutes >= 60 ? `${Math.floor(minutes / 60)}小时${minutes % 60}分` : `${minutes} 分钟`; }
function pointText(point) { return `${point.getLng().toFixed(6)},${point.getLat().toFixed(6)}`; }
function parsePoint(value) {
  const [lon, lat] = value.split(",").map(Number);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error("坐标格式应为 经度,纬度（GCJ-02）");
  return new AMap.LngLat(lon, lat);
}
async function api(path) {
  const response = await fetch(path);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "本地服务请求失败");
  return payload;
}
function clearRoute() { routeOverlays.forEach((overlay) => map.remove(overlay)); routeOverlays = []; }
function setPoints(next) {
  points = next;
  markerOverlays.forEach((overlay) => map.remove(overlay));
  markerOverlays = points.map((point, index) => new AMap.Marker({ position: point, title: index === 0 ? "起点" : "终点", label: { content: index === 0 ? "起点" : "终点", direction: "top" } }));
  map.add(markerOverlays);
  document.querySelector("#origin").value = points[0] ? pointText(points[0]) : "";
  document.querySelector("#destination").value = points[1] ? pointText(points[1]) : "";
}
function drawLine(coordinates, options = {}) {
  const line = new AMap.Polyline({ path: coordinates, strokeColor: options.color || "#2679ce", strokeWeight: options.weight || 6, strokeOpacity: options.opacity ?? .9, strokeStyle: options.dashed ? "dashed" : "solid", strokeDasharray: options.dashed ? [10, 6] : undefined, lineJoin: "round" });
  map.add(line); routeOverlays.push(line); return line;
}
async function calculateRoute() {
  try {
    const origin = parsePoint(document.querySelector("#origin").value);
    const destination = parsePoint(document.querySelector("#destination").value);
    setPoints([origin, destination]); clearRoute(); setStatus("正在调用高德骑行导航…");
    const route = await api(`/api/route?${new URLSearchParams({ origin: pointText(origin), destination: pointText(destination) })}`);
    drawLine(route.geometry);
    map.setFitView([...markerOverlays, ...routeOverlays], false, [30, 30, 30, 30]);
    summaryNode.textContent = `${formatDistance(route.distance_m)} · ${formatDuration(route.duration_s)} · 高德骑行`;
    setStatus("高德骑行路线已完成", "ready");
  } catch (error) { summaryNode.textContent = error.message; setStatus("路线请求失败", "error"); }
}
function renderProbe(probe) {
  clearRoute(); probeItemsNode.replaceChildren();
  for (const feature of probe.features) {
    const properties = feature.properties || {};
    const kind = properties.kind || "connector";
    const isSegment = kind === "strava_segment";
    const isGap = kind === "strava_handoff_gap";
    const isCandidate = kind === "amap_bicycling_candidate";
    const rejectedCandidate = isCandidate && properties.within_requested_distance === false;
    const line = drawLine(feature.geometry.coordinates, { color: rejectedCandidate ? "#d64f3b" : (properties.color || (isSegment ? "#d7438d" : isGap ? "#e0a62b" : "#2d7dd2")), weight: isCandidate ? 6 : isSegment ? 7 : 5, dashed: isGap || rejectedCandidate });
    const item = document.createElement("li");
    item.innerHTML = `<strong>${rejectedCandidate ? "超出目标距离" : isCandidate ? "高德骑行候选" : isSegment ? "Strava 骨架" : isGap ? "待核验接缝" : "连接段"} · ${properties.name || "未命名"}</strong><small>${formatDistance(properties.distance_m || 0)}${properties.duration_s ? ` · ${formatDuration(properties.duration_s)}` : ""}${properties.waypoints ? ` · ${properties.waypoints.join(" → ")}` : ""}${rejectedCandidate ? " · 仅作地图预览" : ""}${isGap ? " · 非高德验证道路" : ""}</small>`;
    item.addEventListener("click", () => map.setFitView([line], false, [30, 30, 30, 30])); probeItemsNode.append(item);
  }
  if (routeOverlays.length) map.setFitView(routeOverlays, false, [30, 30, 30, 30]);
}
async function showProbe() {
  try {
    const name = document.querySelector("#probe-name").value.trim();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error("请输入有效的本地探针名");
    setStatus("正在读取并转换 WGS‑84 探针…");
    const probe = await api(`/api/route-probes/${name}`); renderProbe(probe);
    summaryNode.textContent = `${probe.metadata?.name || name} · 已转换至 GCJ‑02`;
    setStatus("已叠加路线骨架", "ready");
  } catch (error) { setStatus(error.message, "error"); }
}

map.on("click", (event) => { setPoints(points.length >= 2 ? [event.lnglat] : [...points, event.lnglat]); clearRoute(); });
document.querySelector("#route-button").addEventListener("click", calculateRoute);
document.querySelector("#probe-button").addEventListener("click", showProbe);
const requestedProbe = new URLSearchParams(window.location.search).get("probe");
const validRequestedProbe = requestedProbe && /^[a-z0-9][a-z0-9_-]*$/.test(requestedProbe);
api("/health").then(() => {
  setStatus("高德本地服务已就绪", "ready");
  if (validRequestedProbe) {
    document.querySelector("#probe-name").value = requestedProbe;
    return showProbe();
  }
  return null;
}).catch(() => setStatus("本地服务不可用", "error"));
