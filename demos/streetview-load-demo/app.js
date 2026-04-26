import { parseGpx } from "../../src/domain/route/gpx-parser.js";
import { getRouteSampleAtDistance } from "../../src/domain/route/route-builder.js";
import { createStreetViewController, loadGoogleMapsForStreetView } from "../../src/ui/map/street-view-controller.js";

const SIM_SPEED_KMH = 20;
const SIM_SPEED_MPS = SIM_SPEED_KMH / 3.6;
const SIM_TICK_MS = 200;
const PROBE_MIN_INTERVAL_MS = 1000;

const el = {
    gpxInput: document.getElementById("gpxInput"),
    apiKeyInput: document.getElementById("apiKeyInput"),
    loadApiBtn: document.getElementById("loadApiBtn"),
    startBtn: document.getElementById("startBtn"),
    stopBtn: document.getElementById("stopBtn"),
    routeName: document.getElementById("routeName"),
    routeDistance: document.getElementById("routeDistance"),
    positionText: document.getElementById("positionText"),
    gradeText: document.getElementById("gradeText"),
    progressText: document.getElementById("progressText"),
    probeCount: document.getElementById("probeCount"),
    probeAvg: document.getElementById("probeAvg"),
    probeP95: document.getElementById("probeP95"),
    probeSuccessRate: document.getElementById("probeSuccessRate"),
    probeUniquePano: document.getElementById("probeUniquePano"),
    bufferAdvice: document.getElementById("bufferAdvice"),
    statusText: document.getElementById("statusText"),
    pano1: document.getElementById("svPano1"),
    pano2: document.getElementById("svPano2")
};

const state = {
    route: null,
    apiReady: false,
    controller: null,
    simTimer: null,
    simDistanceMeters: 0,
    lastTickMs: 0,
    running: false,
    streetViewService: null,
    lastProbeAt: 0,
    probePending: false,
    probeTotal: 0,
    probeSuccess: 0,
    probeFail: 0,
    probeLatencies: [],
    panoIds: new Set()
};

bindEvents();
renderActionState();

function bindEvents() {
    el.gpxInput.addEventListener("change", handleGpxImport);
    el.loadApiBtn.addEventListener("click", handleLoadApi);
    el.startBtn.addEventListener("click", startSimulation);
    el.stopBtn.addEventListener("click", stopSimulation);
    window.addEventListener("beforeunload", () => {
        stopSimulation();
        state.controller?.destroy?.();
    });
}

async function handleGpxImport(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
        setStatus("正在解析 GPX...");
        const xmlText = await file.text();
        const route = parseGpx(xmlText);
        state.route = route;
        state.simDistanceMeters = 0;
        updateRouteMeta();
        updateRideMetaFromDistance(0);
        setStatus(`GPX 导入成功：${route.name}`);
    } catch (error) {
        setStatus(`GPX 导入失败：${getMessage(error)}`, true);
    } finally {
        event.target.value = "";
        renderActionState();
    }
}

async function handleLoadApi() {
    const apiKey = el.apiKeyInput.value.trim();
    if (!apiKey) {
        setStatus("请输入 Google Maps API Key。", true);
        return;
    }

    el.loadApiBtn.disabled = true;
    el.loadApiBtn.textContent = "加载中...";

    try {
        await loadGoogleMapsForStreetView(apiKey);
        state.controller?.destroy?.();
        state.controller = createStreetViewController({
            container1: el.pano1,
            container2: el.pano2
        });
        state.streetViewService = new window.google.maps.StreetViewService();
        state.apiReady = true;
        setStatus("API 加载完成，可以开始模拟。");
    } catch (error) {
        state.apiReady = false;
        setStatus(`API 加载失败：${getMessage(error)}`, true);
    } finally {
        el.loadApiBtn.disabled = false;
        el.loadApiBtn.textContent = "加载 API";
        renderActionState();
    }
}

function startSimulation() {
    if (!state.route) {
        setStatus("请先导入 GPX。", true);
        return;
    }
    if (!state.apiReady || !state.controller) {
        setStatus("请先加载 API。", true);
        return;
    }

    resetProbeStats();
    state.running = true;
    state.simDistanceMeters = 0;
    state.lastTickMs = performance.now();
    updateRideMetaFromDistance(0);
    setStatus("模拟骑行已开始（20 km/h）。");
    renderActionState();

    if (state.simTimer) {
        window.clearInterval(state.simTimer);
    }
    state.simTimer = window.setInterval(simulationTick, SIM_TICK_MS);
}

function stopSimulation() {
    if (state.simTimer) {
        window.clearInterval(state.simTimer);
        state.simTimer = null;
    }
    if (state.running) {
        setStatus("模拟骑行已停止。");
    }
    state.running = false;
    renderActionState();
}

function simulationTick() {
    if (!state.running || !state.route) {
        return;
    }

    const now = performance.now();
    const deltaSeconds = Math.max(0, (now - state.lastTickMs) / 1000);
    state.lastTickMs = now;
    state.simDistanceMeters += SIM_SPEED_MPS * deltaSeconds;

    if (state.simDistanceMeters >= state.route.totalDistanceMeters) {
        state.simDistanceMeters = state.route.totalDistanceMeters;
    }

    updateRideMetaFromDistance(state.simDistanceMeters);
    updateStreetView(state.simDistanceMeters);
    runNetworkProbe(state.simDistanceMeters);

    if (state.simDistanceMeters >= state.route.totalDistanceMeters) {
        stopSimulation();
        setStatus("路线已骑行完成。");
    }
}

function updateStreetView(distanceMeters) {
    const sample = getRouteSampleAtDistance(state.route, distanceMeters);
    if (!Number.isFinite(sample.latitude) || !Number.isFinite(sample.longitude)) {
        return;
    }

    state.controller.update(state.route, {
        distanceKm: distanceMeters / 1000,
        speedKph: SIM_SPEED_KMH,
        positionLat: sample.latitude,
        positionLong: sample.longitude
    });
}

function runNetworkProbe(distanceMeters) {
    if (!state.streetViewService || state.probePending) {
        return;
    }

    const now = performance.now();
    if (now - state.lastProbeAt < PROBE_MIN_INTERVAL_MS) {
        return;
    }
    state.lastProbeAt = now;

    const sample = getRouteSampleAtDistance(state.route, distanceMeters);
    if (!Number.isFinite(sample.latitude) || !Number.isFinite(sample.longitude)) {
        return;
    }

    const start = performance.now();
    state.probePending = true;
    state.probeTotal += 1;

    state.streetViewService.getPanorama(
        {
            location: new window.google.maps.LatLng(sample.latitude, sample.longitude),
            radius: 50
        },
        (data, status) => {
            state.probePending = false;
            const latency = performance.now() - start;
            state.probeLatencies.push(latency);

            if (status === window.google.maps.StreetViewStatus.OK) {
                state.probeSuccess += 1;
                if (data?.location?.pano) {
                    state.panoIds.add(data.location.pano);
                }
            } else {
                state.probeFail += 1;
            }

            updateProbeUi();
        }
    );
}

function updateRouteMeta() {
    if (!state.route) {
        el.routeName.textContent = "未导入";
        el.routeDistance.textContent = "0.00 km";
        return;
    }
    el.routeName.textContent = state.route.name || "GPX 路线";
    el.routeDistance.textContent = `${(state.route.totalDistanceMeters / 1000).toFixed(2)} km`;
}

function updateRideMetaFromDistance(distanceMeters) {
    if (!state.route) {
        return;
    }

    const sample = getRouteSampleAtDistance(state.route, distanceMeters);
    const progress = state.route.totalDistanceMeters > 0
        ? (distanceMeters / state.route.totalDistanceMeters) * 100
        : 0;

    el.progressText.textContent = `${progress.toFixed(1)} %`;
    el.gradeText.textContent = `${(sample.gradePercent ?? 0).toFixed(1)} %`;
    el.positionText.textContent = Number.isFinite(sample.latitude) && Number.isFinite(sample.longitude)
        ? `${sample.latitude.toFixed(5)}, ${sample.longitude.toFixed(5)}`
        : "无 GPS 点";
}

function updateProbeUi() {
    const count = state.probeLatencies.length;
    const avg = count > 0 ? state.probeLatencies.reduce((sum, v) => sum + v, 0) / count : 0;
    const p95 = count > 0 ? percentile(state.probeLatencies, 95) : 0;
    const successRate = state.probeTotal > 0 ? (state.probeSuccess / state.probeTotal) * 100 : 0;

    el.probeCount.textContent = String(count);
    el.probeAvg.textContent = count > 0 ? `${avg.toFixed(0)} ms` : "-- ms";
    el.probeP95.textContent = count > 0 ? `${p95.toFixed(0)} ms` : "-- ms";
    el.probeSuccessRate.textContent = state.probeTotal > 0 ? `${successRate.toFixed(1)} %` : "--";
    el.probeUniquePano.textContent = String(state.panoIds.size);
    el.bufferAdvice.textContent = adviseBuffer(p95, successRate, count);
}

function adviseBuffer(p95Ms, successRate, sampleCount) {
    if (sampleCount < 5) {
        return "样本不足";
    }
    if (successRate < 90 || p95Ms > 2200) {
        return "建议三缓冲";
    }
    if (p95Ms > 1200) {
        return "双缓冲临界";
    }
    return "双缓冲足够";
}

function percentile(values, p) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
}

function resetProbeStats() {
    state.lastProbeAt = 0;
    state.probePending = false;
    state.probeTotal = 0;
    state.probeSuccess = 0;
    state.probeFail = 0;
    state.probeLatencies = [];
    state.panoIds = new Set();
    updateProbeUi();
}

function renderActionState() {
    const ready = Boolean(state.route && state.apiReady && state.controller);
    el.startBtn.disabled = !ready || state.running;
    el.stopBtn.disabled = !state.running;
}

function setStatus(message, isError = false) {
    el.statusText.textContent = message;
    el.statusText.classList.toggle("error", isError);
}

function getMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
