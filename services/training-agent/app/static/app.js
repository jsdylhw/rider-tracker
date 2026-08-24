const state = {
  files: [],
  selectedPath: null,
  chatSessionId: null,
  chatPending: false,
};

const API_TOKEN_STORAGE_KEY = "personal-fit-agent.api-token";
const CHAT_SESSION_STORAGE_KEY = "personal-fit-agent.chat-session";

const els = {
  status: document.getElementById("status"),
  fitDir: document.getElementById("fitDir"),
  fitList: document.getElementById("fitList"),
  detailTitle: document.getElementById("detailTitle"),
  detailMeta: document.getElementById("detailMeta"),
  summaryGrid: document.getElementById("summaryGrid"),
  stravaSummary: document.getElementById("stravaSummary"),
  reportText: document.getElementById("reportText"),
  log: document.getElementById("log"),
  connectGarminBtn: document.getElementById("connectGarminBtn"),
  downloadCount: document.getElementById("downloadCount"),
  downloadBtn: document.getElementById("downloadBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  analyzeBtn: document.getElementById("analyzeBtn"),
  viewReportBtn: document.getElementById("viewReportBtn"),
  uploadStravaBtn: document.getElementById("uploadStravaBtn"),
  apiToken: document.getElementById("apiToken"),
  chatMessages: document.getElementById("chatMessages"),
  chatForm: document.getElementById("chatForm"),
  chatInput: document.getElementById("chatInput"),
  sendChatBtn: document.getElementById("sendChatBtn"),
  clearChatBtn: document.getElementById("clearChatBtn"),
  presentations: document.getElementById("presentations"),
};

function setStatus(text) {
  els.status.textContent = text;
}

function log(message, data) {
  const time = new Date().toLocaleTimeString();
  const suffix = data ? `\n${JSON.stringify(data, null, 2)}` : "";
  els.log.textContent = `[${time}] ${message}${suffix}\n\n${els.log.textContent}`;
}

function apiHeaders(headers = {}) {
  const token = els.apiToken.value.trim();
  return {
    "content-type": "application/json",
    ...(token ? { "X-API-Token": token } : {}),
    ...headers,
  };
}

function restoreApiToken() {
  els.apiToken.value = sessionStorage.getItem(API_TOKEN_STORAGE_KEY) || "";
}

function persistApiToken() {
  const token = els.apiToken.value.trim();
  if (token) {
    sessionStorage.setItem(API_TOKEN_STORAGE_KEY, token);
  } else {
    sessionStorage.removeItem(API_TOKEN_STORAGE_KEY);
  }
}

function randomId(prefix) {
  const value = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${value}`;
}

function restoreChatSession() {
  state.chatSessionId = sessionStorage.getItem(CHAT_SESSION_STORAGE_KEY) || randomId("session");
  sessionStorage.setItem(CHAT_SESSION_STORAGE_KEY, state.chatSessionId);
}

async function fetchJson(url, options = {}) {
  const { headers, json, ...requestOptions } = options;
  const response = await fetch(url, {
    ...requestOptions,
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    headers: apiHeaders(headers),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 600)}`);
  }
  return response.json();
}

async function refreshFiles() {
  setStatus("读取本地 FIT");
  const data = await fetchJson("/api/fit-files");
  state.files = data.files || [];
  els.fitDir.textContent = data.fit_dir || "";
  renderList();
  if (state.files.length && !state.files.some((file) => file.path === state.selectedPath)) {
    state.selectedPath = state.files[0].path;
  }
  renderDetail();
  setStatus("准备就绪");
}

function renderList() {
  if (!state.files.length) {
    els.fitList.innerHTML = `<div class="empty">还没有本地 FIT。先连接 Garmin 并下载最近活动。</div>`;
    return;
  }

  els.fitList.innerHTML = state.files
    .map((file) => {
      const display = file.display_summary || {};
      const active = file.path === state.selectedPath ? " active" : "";
      const badge = file.has_summary ? "已分析" : "未分析";
      const label = display.summary_label ? ` · ${display.summary_label}` : "";
      return `
        <button class="fit-item${active}" data-path="${escapeAttr(file.path)}">
          <span class="fit-name">${escapeHtml(file.name)}</span>
          <span class="fit-meta">${escapeHtml(formatDate(display.start_time))} ${formatKm(display.distance_km)} ${formatMin(display.duration_min)}${escapeHtml(label)}</span>
          <span class="badge ${file.has_summary ? "done" : ""}">${badge}</span>
        </button>
      `;
    })
    .join("");

  document.querySelectorAll(".fit-item").forEach((button) => {
    button.addEventListener("click", () => selectFile(button.dataset.path));
  });
}

function selectFile(path) {
  state.selectedPath = path;
  renderList();
  renderDetail();
}

function selectedFile() {
  return state.files.find((file) => file.path === state.selectedPath) || null;
}

function renderDetail() {
  const file = selectedFile();
  if (!file) {
    els.detailTitle.textContent = "选择一个 FIT 文件";
    els.detailMeta.textContent = "";
    els.summaryGrid.innerHTML = "";
    els.stravaSummary.textContent = "分析后会显示。";
    els.reportText.textContent = "点击“查看报告”后显示。";
    setActionButtons(false);
    return;
  }

  const display = file.display_summary || {};
  els.detailTitle.textContent = file.name;
  els.detailMeta.textContent = [
    display.sport_type || "unknown",
    display.sub_sport,
    formatDate(display.start_time),
  ].filter(Boolean).join(" · ");
  els.stravaSummary.textContent = file.strava_summary || display.brief || "还没有分析结果。";
  renderSummary(display, file);
  setActionButtons(true);
}

function renderSummary(display, file) {
  const items = [
    ["状态", file.has_summary ? "已分析" : "未分析"],
    ["开始时间", formatDate(display.start_time)],
    ["距离", formatKm(display.distance_km)],
    ["时长", formatMin(display.duration_min)],
    ["训练刺激", display.main_stimulus || "-"],
    ["负荷标签", display.load_label || "-"],
    ["活动标签", display.summary_label || "-"],
    ["口吻", file.strava_summary_tone?.name || "-"],
  ];
  els.summaryGrid.innerHTML = items
    .map(([label, val]) => `
      <div class="metric">
        <div class="metric-label">${escapeHtml(label)}</div>
        <div class="metric-value">${escapeHtml(val)}</div>
      </div>
    `)
    .join("");
}

function setActionButtons(enabled) {
  els.analyzeBtn.disabled = !enabled;
  els.viewReportBtn.disabled = !enabled;
  els.uploadStravaBtn.disabled = !enabled;
}

async function connectGarmin() {
  setStatus("连接 Garmin");
  try {
    const result = await fetchJson("/api/garmin/connect", { method: "POST", body: "{}" });
    log("Garmin 连接成功", result);
    setStatus("Garmin 已连接");
  } catch (error) {
    log("Garmin 连接失败", { error: error.message });
    setStatus("连接失败");
  }
}

async function downloadRecent() {
  const count = Number(els.downloadCount.value || 5);
  setStatus("下载中");
  try {
    const result = await fetchJson("/api/garmin/download", {
      method: "POST",
      body: JSON.stringify({ count }),
    });
    log("下载完成", result);
    await refreshFiles();
  } catch (error) {
    log("下载失败", { error: error.message });
    setStatus("下载失败");
  }
}

async function analyzeSelected() {
  const file = selectedFile();
  if (!file) return;
  setStatus("大模型分析中");
  try {
    const result = await fetchJson("/api/fit-files/analyze", {
      method: "POST",
      body: JSON.stringify({ path: file.path, history: false, force: true }),
    });
    log("分析完成", {
      activity_key: result.activity_key,
      tone: result.strava_summary_tone,
    });
    await refreshFiles();
    state.selectedPath = file.path;
    renderList();
    renderDetail();
  } catch (error) {
    log("分析失败", { error: error.message });
    setStatus("分析失败");
  }
}

async function viewReport() {
  const file = selectedFile();
  if (!file || !file.has_summary) {
    els.reportText.textContent = "还没有 summary，请先分析。";
    return;
  }
  setStatus("读取报告");
  try {
    const summary = await fetchJson(`/api/summary?activity_key=${encodeURIComponent(file.activity_key)}`);
    els.reportText.textContent = summary.markdown_report || "(报告为空)";
    setStatus("准备就绪");
  } catch (error) {
    els.reportText.textContent = error.message;
    setStatus("读取报告失败");
  }
}

async function uploadStrava() {
  const file = selectedFile();
  if (!file || !file.has_summary) {
    log("上传失败", { error: "还没有 summary，请先分析。" });
    return;
  }
  setStatus("上传 Strava");
  try {
    const result = await fetchJson("/api/strava/upload", {
      method: "POST",
      body: JSON.stringify({ activity_key: file.activity_key, wait: true }),
    });
    const uploadStatus = result.upload_status || {};
    const completed = ["duplicate", "description_updated"].includes(result.status)
      || Boolean(uploadStatus.activity_id);
    if (!completed) {
      if (uploadStatus.error) {
        throw new Error(uploadStatus.error);
      }
      log("Strava 上传状态未确认", result);
      setStatus("Strava 处理超时，尚未确认最终结果");
      return;
    }
    log("Strava 上传完成", result);
    setStatus(result.status === "duplicate" ? "Strava 已存在该活动" : "上传完成");
  } catch (error) {
    log("Strava 上传失败", { error: error.message });
    setStatus("上传失败");
  }
}

async function sendChat(message) {
  if (state.chatPending) return;
  const text = String(message || "").trim();
  if (!text) return;

  state.chatPending = true;
  els.sendChatBtn.disabled = true;
  els.chatInput.disabled = true;
  appendChatMessage("user", text);
  els.chatInput.value = "";
  setStatus("Agent 处理中");

  try {
    const result = await fetchJson("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        session_id: state.chatSessionId,
        request_id: randomId("request"),
        message: text,
      }),
    });
    appendChatMessage("assistant", result.answer || "已完成。", result.executions || []);
    renderPresentations(result.presentations || []);
    setStatus("准备就绪");
  } catch (error) {
    appendChatMessage("error", `请求失败：${error.message}`);
    setStatus("Agent 请求失败");
  } finally {
    state.chatPending = false;
    els.sendChatBtn.disabled = false;
    els.chatInput.disabled = false;
    els.chatInput.focus();
  }
}

function appendChatMessage(role, text, executions = []) {
  els.chatMessages.querySelector(".chat-empty")?.remove();
  const article = document.createElement("article");
  article.className = `chat-message ${role}`;

  const label = document.createElement("div");
  label.className = "chat-role";
  label.textContent = role === "user" ? "你" : role === "assistant" ? "Agent" : "错误";
  article.appendChild(label);

  const body = document.createElement("div");
  body.className = "chat-body";
  body.textContent = text;
  article.appendChild(body);

  const completedTools = executions
    .filter((item) => item && item.tool)
    .map((item) => item.tool);
  if (completedTools.length) {
    const trace = document.createElement("div");
    trace.className = "chat-trace";
    trace.textContent = `已执行：${completedTools.join(" → ")}`;
    article.appendChild(trace);
  }
  els.chatMessages.appendChild(article);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function renderPresentations(blocks) {
  els.presentations.replaceChildren();
  if (!blocks.length) {
    const empty = document.createElement("div");
    empty.className = "chat-empty";
    empty.textContent = "本轮没有结构化展示结果。";
    els.presentations.appendChild(empty);
    return;
  }

  blocks.forEach((block) => {
    const section = document.createElement("section");
    section.className = "presentation-card";
    const title = document.createElement("h3");
    title.textContent = block.title || "结构化结果";
    section.appendChild(title);

    if (block.type === "metric_cards") {
      section.appendChild(renderMetricCards(block.data || {}));
    } else if (block.type === "table") {
      section.appendChild(renderPresentationTable(block.data || {}));
    } else if (block.type === "line_chart") {
      section.appendChild(renderLineCharts(block.data || {}));
    } else if (block.type === "route_map") {
      section.appendChild(renderRouteMap(block.data || {}, block.presentation_id));
    } else if (block.type === "markdown") {
      const markdown = document.createElement("pre");
      markdown.className = "presentation-markdown";
      markdown.textContent = block.data?.markdown || "";
      section.appendChild(markdown);
    }
    els.presentations.appendChild(section);
  });
}

function renderRouteMap(data, presentationId) {
  const wrapper = document.createElement("div");
  wrapper.className = "route-map-view";
  const controls = document.createElement("div");
  controls.className = "route-map-controls";
  const container = document.createElement("div");
  container.className = "route-map";
  container.id = `route-map-${String(presentationId || randomId("map")).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  wrapper.append(controls, container);
  const routes = Array.isArray(data.routes) ? data.routes : [];
  queueMicrotask(() => {
    if (!window.L || !container.isConnected || !routes.length) {
      if (!window.L) container.textContent = "地图组件加载失败，路线摘要仍可使用。";
      return;
    }
    const map = L.map(container, { zoomControl: true }).setView([0, 0], 2);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    const candidateRoutes = routes.filter((route) => route.kind !== "strava_segment");
    const segmentRoutes = routes.filter((route) => route.kind === "strava_segment");
    let selectedCandidateIndex = Math.max(0, candidateRoutes.findIndex((route) => route.active));
    const selectedSegmentIndexes = [];
    let layerGroup = L.featureGroup().addTo(map);
    const candidateButtons = candidateRoutes.map((route, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "route-map-choice";
      button.textContent = route.name || `路线 ${index + 1}`;
      button.addEventListener("click", async () => {
        selectedCandidateIndex = index;
        drawSelected();
        if (data.plan_id && route.candidate_id) {
          try {
            await fetchJson("/api/route-plans/select", {
              method: "POST",
              json: {
                session_id: state.chatSessionId,
                plan_id: data.plan_id,
                candidate_id: route.candidate_id,
              },
            });
          } catch (error) {
            appendChatMessage("error", `路线预览状态保存失败：${error.message}`);
          }
        }
      });
      controls.appendChild(button);
      return button;
    });
    if (segmentRoutes.length) {
      const hint = document.createElement("div");
      hint.className = "route-map-hint";
      hint.textContent = "点击路段可多选（最多 3 条），选择顺序就是骑行顺序。";
      controls.appendChild(hint);
    }
    const segmentButtons = segmentRoutes.map((route, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "route-map-choice";
      button.textContent = route.name || `Strava 路段 ${index + 1}`;
      button.addEventListener("click", () => {
        const selectedPosition = selectedSegmentIndexes.indexOf(index);
        if (selectedPosition >= 0) {
          selectedSegmentIndexes.splice(selectedPosition, 1);
        } else if (selectedSegmentIndexes.length < 3) {
          selectedSegmentIndexes.push(index);
        }
        drawSelected();
      });
      controls.appendChild(button);
      return button;
    });
    let composeButton = null;
    if (segmentRoutes.length && data.plan_id) {
      composeButton = document.createElement("button");
      composeButton.type = "button";
      composeButton.className = "primary";
      composeButton.disabled = true;
      composeButton.textContent = "用所选路段生成路线";
      composeButton.addEventListener("click", () => {
        const selected = selectedSegmentIndexes.map((index) => segmentRoutes[index]);
        if (!selected.length) return;
        const description = selected
          .map((route) => `${route.name || "Strava 路段"}（ID ${route.segment_id}）`)
          .join(" → ");
        sendChat(`请按这个顺序使用当前路线已发现的 Strava 路段生成新候选：${description}`);
      });
      controls.appendChild(composeButton);
    }

    function drawSelected() {
      layerGroup.remove();
      layerGroup = L.featureGroup().addTo(map);
      candidateButtons.forEach((button, index) => {
        button.classList.toggle("active", index === selectedCandidateIndex);
      });
      segmentButtons.forEach((button, index) => {
        button.classList.toggle("active", selectedSegmentIndexes.includes(index));
      });
      if (composeButton) {
        composeButton.disabled = selectedSegmentIndexes.length === 0;
        composeButton.textContent = selectedSegmentIndexes.length
          ? `用所选 ${selectedSegmentIndexes.length} 条路段生成路线`
          : "用所选路段生成路线";
      }
      const palette = ["#087f6c", "#d97706", "#2563eb", "#9333ea", "#dc2626", "#0891b2", "#65a30d"];
      const visibleRoutes = [];
      if (candidateRoutes[selectedCandidateIndex]) {
        visibleRoutes.push({ route: candidateRoutes[selectedCandidateIndex], color: "#087f6c" });
      }
      selectedSegmentIndexes.forEach((segmentIndex, order) => {
        const route = segmentRoutes[segmentIndex];
        if (route) visibleRoutes.push({ route, color: palette[(order + 1) % palette.length] });
      });
      if (!visibleRoutes.length && segmentRoutes[0]) {
        visibleRoutes.push({ route: segmentRoutes[0], color: "#d7438d" });
      }
      visibleRoutes.forEach(({ route, color }) => {
        if (!route) return;
        const coordinates = route.geometry?.coordinates;
        if (!Array.isArray(coordinates) || coordinates.length < 2) return;
        const isStravaSegment = route.kind === "strava_segment";
        L.geoJSON(route.geometry, {
          style: {
            color,
            weight: route.active ? 6 : 4,
            opacity: route.active ? 0.95 : 0.85,
            dashArray: isStravaSegment ? "7 5" : null,
          },
        }).addTo(layerGroup).bindPopup(leafletText(route.name || "路线候选"));
        (Array.isArray(route.waypoints) ? route.waypoints : []).forEach((point, pointIndex) => {
          const lat = Number(point.latitude);
          const lon = Number(point.longitude);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
          L.circleMarker([lat, lon], {
            radius: pointIndex === 0 ? 7 : 5,
            color,
            fillColor: "#fff",
            fillOpacity: 1,
            weight: 3,
          }).addTo(layerGroup).bindTooltip(leafletText(point.name || `途经点 ${pointIndex + 1}`));
        });
      });
      const bounds = layerGroup.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds.pad(0.08));
    }

    drawSelected();
  });
  return wrapper;
}

function leafletText(value) {
  const content = document.createElement("span");
  content.textContent = String(value ?? "");
  return content;
}

function renderMetricCards(data) {
  const grid = document.createElement("div");
  grid.className = "presentation-metrics";
  const items = Array.isArray(data.items) ? data.items : [];
  items.forEach((item) => {
    const card = document.createElement("div");
    card.className = "presentation-metric";
    const label = document.createElement("div");
    label.className = "metric-label";
    label.textContent = presentationColumnLabel(item.metric);
    const value = document.createElement("div");
    value.className = "metric-value";
    value.textContent = `${item.value ?? "-"}${item.unit ? ` ${item.unit}` : ""}`;
    card.append(label, value);
    grid.appendChild(card);
  });
  return grid;
}

function renderPresentationTable(data) {
  const wrapper = document.createElement("div");
  wrapper.className = "presentation-table-wrap";
  const table = document.createElement("table");
  table.className = "presentation-table";
  const columns = Array.isArray(data.columns) ? data.columns : [];
  const rows = Array.isArray(data.rows) ? data.rows : [];

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  columns.forEach((column) => {
    const cell = document.createElement("th");
    cell.textContent = presentationColumnLabel(column);
    headRow.appendChild(cell);
  });
  head.appendChild(headRow);
  table.appendChild(head);

  const body = document.createElement("tbody");
  rows.forEach((row) => {
    const tableRow = document.createElement("tr");
    columns.forEach((column) => {
      const cell = document.createElement("td");
      cell.textContent = formatPresentationValue(row?.[column], column);
      tableRow.appendChild(cell);
    });
    body.appendChild(tableRow);
  });
  table.appendChild(body);
  wrapper.appendChild(table);
  return wrapper;
}

function renderLineCharts(data) {
  const container = document.createElement("div");
  container.className = "line-charts";
  const labels = Array.isArray(data.labels) ? data.labels : [];
  const series = Array.isArray(data.series) ? data.series : [];
  series.forEach((item) => {
    const values = Array.isArray(item.values) ? item.values : [];
    const numeric = values.map((value) => value === null || value === undefined ? Number.NaN : Number(value));
    const valid = numeric.filter(Number.isFinite);
    if (!valid.length) return;

    const card = document.createElement("div");
    card.className = "chart-series";
    const heading = document.createElement("div");
    heading.className = "chart-title";
    heading.textContent = `${presentationColumnLabel(item.metric)}${item.unit ? ` (${item.unit})` : ""}`;
    card.appendChild(heading);
    const summary = document.createElement("div");
    summary.className = "chart-summary";
    summary.textContent = chartSeriesSummary(numeric, item.unit);
    card.appendChild(summary);
    card.appendChild(buildLineSvg(labels, numeric, item.unit, data.x_label));
    container.appendChild(card);
  });
  return container;
}

function buildLineSvg(labels, values, unit, xLabel) {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  const width = 640;
  const height = 220;
  const padLeft = 58;
  const padRight = 20;
  const padTop = 28;
  const padBottom = 42;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "训练周期折线图");

  const valid = values.filter(Number.isFinite);
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const span = max - min || 1;
  const x = (index) => padLeft + (values.length <= 1 ? 0 : index * (width - padLeft - padRight) / (values.length - 1));
  const y = (value) => height - padBottom - (value - min) * (height - padTop - padBottom) / span;

  [min, min + span / 2, max].forEach((tickValue) => {
    const tickY = y(tickValue);
    const grid = document.createElementNS(namespace, "line");
    grid.setAttribute("x1", padLeft);
    grid.setAttribute("x2", width - padRight);
    grid.setAttribute("y1", tickY);
    grid.setAttribute("y2", tickY);
    grid.setAttribute("class", "chart-grid");
    svg.appendChild(grid);

    const tick = document.createElementNS(namespace, "text");
    tick.setAttribute("x", padLeft - 8);
    tick.setAttribute("y", tickY + 4);
    tick.setAttribute("class", "chart-y-label");
    tick.textContent = formatChartNumber(tickValue);
    svg.appendChild(tick);
  });
  let pathData = "";
  let drawing = false;
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      drawing = false;
      return;
    }
    pathData += `${drawing ? " L" : " M"} ${x(index)} ${y(value)}`;
    drawing = true;
  });

  const line = document.createElementNS(namespace, "path");
  line.setAttribute("d", pathData.trim());
  line.setAttribute("class", "chart-line");
  svg.appendChild(line);

  if (values.length <= 40) {
    values.forEach((value, index) => {
      if (!Number.isFinite(value)) return;
      const point = document.createElementNS(namespace, "circle");
      point.setAttribute("cx", x(index));
      point.setAttribute("cy", y(value));
      point.setAttribute("r", "4");
      point.setAttribute("class", "chart-point");
      const tooltip = document.createElementNS(namespace, "title");
      tooltip.textContent = `${labels[index] || index + 1}: ${value}${unit ? ` ${unit}` : ""}`;
      point.appendChild(tooltip);
      svg.appendChild(point);
    });
  }

  const valueLabelIndices = values.length <= 8
    ? values.map((_, index) => index)
    : [];
  valueLabelIndices.forEach((index) => {
    const value = values[index];
    if (!Number.isFinite(value)) return;
    const label = document.createElementNS(namespace, "text");
    label.setAttribute("x", x(index));
    label.setAttribute("y", Math.max(14, y(value) - 9));
    label.setAttribute("class", "chart-value-label");
    label.textContent = formatChartNumber(value);
    svg.appendChild(label);
  });

  const labelIndices = values.length <= 6
    ? values.map((_, index) => index)
    : [0, Math.floor((values.length - 1) / 2), values.length - 1];
  labelIndices.forEach((index) => {
    const label = document.createElementNS(namespace, "text");
    label.setAttribute("x", x(index));
    label.setAttribute("y", height - 20);
    label.setAttribute("class", "chart-label");
    label.textContent = labels[index] || "";
    svg.appendChild(label);
  });
  if (xLabel) {
    const axisTitle = document.createElementNS(namespace, "text");
    axisTitle.setAttribute("x", (padLeft + width - padRight) / 2);
    axisTitle.setAttribute("y", height - 4);
    axisTitle.setAttribute("class", "chart-axis-title");
    axisTitle.textContent = xLabel;
    svg.appendChild(axisTitle);
  }
  return svg;
}

function chartSeriesSummary(values, unit) {
  const valid = values.filter(Number.isFinite);
  const first = valid[0];
  const last = valid[valid.length - 1];
  const suffix = unit ? ` ${unit}` : "";
  return `起点 ${formatChartNumber(first)}${suffix} → 终点 ${formatChartNumber(last)}${suffix} · 范围 ${formatChartNumber(Math.min(...valid))}–${formatChartNumber(Math.max(...valid))}${suffix}`;
}

function formatChartNumber(value) {
  if (!Number.isFinite(Number(value))) return "-";
  const numeric = Number(value);
  return Math.abs(numeric) >= 100 ? numeric.toFixed(0) : numeric.toFixed(1);
}

function presentationColumnLabel(value) {
  return {
    dimension: "维度",
    metric: "指标",
    baseline: "基准期",
    current: "当前期",
    change: "变化",
    unit: "单位",
    confidence: "置信度",
    volume: "训练量",
    intensity: "强度",
    consistency: "规律性",
    performance: "表现",
    efficiency: "效率",
    recovery: "恢复",
    duration_min: "时长",
    distance_km: "距离",
    tss: "TSS",
    sport_type: "运动类型",
    start_time_local: "开始时间",
    cumulative_distance_km: "累计距离",
    heart_rate_bpm: "心率",
    power_w: "功率",
    summary_label: "活动标签",
    candidate: "候选路线",
    stage: "行程阶段",
    segment_name: "Strava 路段",
    segment_id: "路段 ID",
    strava_segments: "经过路段",
    kind: "候选类型",
    waypoints: "途经点",
    handoff_km: "衔接距离",
    provider: "算路服务",
    average_grade_percent: "平均坡度",
    elevation_difference_m: "海拔差",
    climb_category: "爬坡分类",
    distance_to_route_km: "距计划路线",
    route_overlap_ratio: "走廊内比例",
    mode: "模式",
    active: "当前使用",
    confirmed: "已确认",
    elevation_m: "海拔",
    activity_count: "活动数量",
    intensity_factor: "强度因子",
    main_stimulus: "主要刺激",
    load_label: "负荷标签",
  }[value] || String(value || "-");
}

function formatPresentationValue(value, column) {
  if (value === null || value === undefined || value === "") return "-";
  if (column === "dimension" || column === "metric") return presentationColumnLabel(value);
  if (column === "change" && Number.isFinite(Number(value))) return `${Number(value).toFixed(1)}%`;
  return String(value);
}

function clearChat() {
  state.chatSessionId = randomId("session");
  sessionStorage.setItem(CHAT_SESSION_STORAGE_KEY, state.chatSessionId);
  els.chatMessages.innerHTML = '<div class="chat-empty">已开始新会话。</div>';
  els.presentations.innerHTML = '<div class="chat-empty">表格、趋势图和活动报告会显示在这里。</div>';
  els.chatInput.value = "";
  els.chatInput.focus();
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatKm(value) {
  return value === null || value === undefined ? "-" : `${Number(value).toFixed(2)} km`;
}

function formatMin(value) {
  return value === null || value === undefined ? "-" : `${Number(value).toFixed(1)} min`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

els.connectGarminBtn.addEventListener("click", connectGarmin);
els.downloadBtn.addEventListener("click", downloadRecent);
els.refreshBtn.addEventListener("click", refreshFiles);
els.analyzeBtn.addEventListener("click", analyzeSelected);
els.viewReportBtn.addEventListener("click", viewReport);
els.uploadStravaBtn.addEventListener("click", uploadStrava);
els.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendChat(els.chatInput.value);
});
els.chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    els.chatForm.requestSubmit();
  }
});
els.clearChatBtn.addEventListener("click", clearChat);

restoreApiToken();
restoreChatSession();
els.apiToken.addEventListener("change", persistApiToken);

refreshFiles().catch((error) => {
  log("初始化失败", { error: error.message });
  setStatus("初始化失败");
});
