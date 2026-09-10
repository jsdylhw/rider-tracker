const CAPABILITY_NAMES = [
    "fit_ingestion", "activity_detail", "athlete_profile", "strava", "garmin_sync",
    "activity_analysis", "training_history", "ai_route_planning", "domestic_ai_routes",
    "international_ai_routes", "map_waypoint_routes", "map_exploration", "street_view",
    "google_elevation_reference", "route_narration", "imported_route_grade_simulation",
    "custom_workout"
];

export const DEFAULT_AGENT_CAPABILITIES = Object.freeze({
    schemaVersion: "training_backend_capabilities.v2",
    backend: "checking",
    llm: "checking",
    reason: "正在检查 Training Agent 能力。",
    providers: Object.freeze({}),
    capabilities: Object.freeze(Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, false])))
});

export function normalizeAgentCapabilities(payload) {
    const value = payload?.result ?? payload;
    if (value?.backend !== "available") return unavailableAgentCapabilities(value?.error);
    const capabilities = value.capabilities && typeof value.capabilities === "object"
        ? value.capabilities : {};
    return {
        schemaVersion: String(value.schema_version || "training_backend_capabilities.v2"),
        backend: "available",
        llm: ["ready", "disabled", "not_configured"].includes(value.llm) ? value.llm : "not_configured",
        reason: String(value.reason || ""),
        providers: normalizeProviders(value.providers),
        capabilities: Object.fromEntries(
            CAPABILITY_NAMES.map((name) => [name, capabilities[name] === true])
        )
    };
}

export function unavailableAgentCapabilities(reason = "Training Agent 当前未运行。") {
    return {
        ...DEFAULT_AGENT_CAPABILITIES,
        backend: "unavailable",
        llm: "unavailable",
        reason: String(reason || "Training Agent 当前未运行。"),
        providers: {},
        capabilities: { ...DEFAULT_AGENT_CAPABILITIES.capabilities }
    };
}

export function capabilityMessage(state, capability) {
    if (state?.backend === "checking") return "正在检查 Training Agent，请稍候。";
    if (state?.backend !== "available") return "Training Agent 当前未运行，基础骑行功能仍可使用。";
    if (state?.capabilities?.[capability] === true) return "";
    const providerMessage = missingProviderMessage(state, capability);
    if (providerMessage) return providerMessage;
    if (state?.llm === "disabled") return "AI 功能已关闭，基础骑行功能仍可使用。";
    return "尚未配置大模型 API，基础骑行功能仍可使用。";
}

function normalizeProviders(providers) {
    if (!providers || typeof providers !== "object") return {};
    return Object.fromEntries(Object.entries(providers).map(([name, value]) => [name, {
        status: String(value?.status || "missing"),
        reason: String(value?.reason || "")
    }]));
}

function missingProviderMessage(state, capability) {
    const requiresGoogle = new Set([
        "ai_route_planning", "domestic_ai_routes", "international_ai_routes",
        "map_waypoint_routes", "map_exploration", "street_view",
        "google_elevation_reference", "route_narration"
    ]);
    if (requiresGoogle.has(capability) && state?.providers?.google?.status !== "ready") {
        return "尚未配置 Google API，此在线地图功能不可用。";
    }
    if (capability === "domestic_ai_routes" && state?.providers?.amap?.status !== "ready") {
        return "国内 AI 路线还需要配置 AMap Web Service Key。";
    }
    if (capability === "strava" && state?.providers?.strava?.status !== "ready") {
        return "尚未配置 Strava 应用凭据。";
    }
    if (capability === "garmin_sync" && state?.providers?.garmin?.status !== "ready") {
        return "尚未配置 Garmin Connect 账号。";
    }
    return "";
}
