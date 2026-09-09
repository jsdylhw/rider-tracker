export const DEFAULT_AGENT_CAPABILITIES = Object.freeze({
    schemaVersion: "training_backend_capabilities.v1",
    backend: "checking",
    llm: "checking",
    reason: "正在检查 Training Agent 能力。",
    capabilities: Object.freeze({
        fit_ingestion: false,
        activity_detail: false,
        athlete_profile: false,
        strava: false,
        activity_analysis: false,
        training_history: false,
        ai_route_planning: false,
        route_narration: false,
    })
});

export function normalizeAgentCapabilities(payload) {
    const value = payload?.result ?? payload;
    if (value?.backend !== "available") return unavailableAgentCapabilities(value?.error);
    const capabilities = value.capabilities && typeof value.capabilities === "object"
        ? value.capabilities : {};
    return {
        schemaVersion: String(value.schema_version || "training_backend_capabilities.v1"),
        backend: "available",
        llm: ["ready", "disabled", "not_configured"].includes(value.llm) ? value.llm : "not_configured",
        reason: String(value.reason || ""),
        capabilities: Object.fromEntries(
            Object.keys(DEFAULT_AGENT_CAPABILITIES.capabilities)
                .map((name) => [name, capabilities[name] === true])
        )
    };
}

export function unavailableAgentCapabilities(reason = "Training Agent 当前未运行。") {
    return {
        ...DEFAULT_AGENT_CAPABILITIES,
        backend: "unavailable",
        llm: "unavailable",
        reason: String(reason || "Training Agent 当前未运行。"),
        capabilities: { ...DEFAULT_AGENT_CAPABILITIES.capabilities }
    };
}

export function capabilityMessage(state, capability) {
    if (state?.backend === "checking") return "正在检查 Training Agent，请稍候。";
    if (state?.backend !== "available") return "Training Agent 当前未运行，基础骑行功能仍可使用。";
    if (state?.capabilities?.[capability] === true) return "";
    if (state?.llm === "disabled") return "AI 功能已关闭，基础骑行功能仍可使用。";
    return "尚未配置大模型 API，基础骑行功能仍可使用。";
}
