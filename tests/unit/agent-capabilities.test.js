import {
    capabilityMessage,
    normalizeAgentCapabilities,
    unavailableAgentCapabilities
} from "../../src/domain/agent/agent-capabilities.js";
import { createAgentCapabilityService } from "../../src/app/services/agent-capability-service.js";
import { assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "agent-capabilities",
    tests: [
        {
            name: "keeps deterministic backend capabilities when llm is not configured",
            run() {
                const state = normalizeAgentCapabilities({ result: {
                    schema_version: "training_backend_capabilities.v1",
                    backend: "available",
                    llm: "not_configured",
                    capabilities: { fit_ingestion: true, strava: true }
                } });

                assertEqual(state.backend, "available");
                assertEqual(state.capabilities.fit_ingestion, true);
                assertEqual(state.capabilities.strava, true);
                assertEqual(state.capabilities.ai_route_planning, false);
                assertEqual(capabilityMessage(state, "activity_analysis").includes("尚未配置"), true);
            }
        },
        {
            name: "publishes unavailable state and later recovers on refresh",
            async run() {
                let available = false;
                let state = {};
                const store = {
                    setState(updater) { state = updater(state); }
                };
                const service = createAgentCapabilityService({
                    store,
                    fetchImpl: async () => available
                        ? fakeResponse({ ok: true, result: {
                            backend: "available", llm: "ready",
                            capabilities: { activity_analysis: true, ai_route_planning: true }
                        } })
                        : fakeResponse({ ok: false, code: "agent_unavailable", error: "offline" }, 503)
                });

                await service.refresh();
                assertEqual(state.agentCapabilities.backend, "unavailable");
                available = true;
                await service.refresh();
                assertEqual(state.agentCapabilities.backend, "available");
                assertEqual(state.agentCapabilities.capabilities.ai_route_planning, true);
                service.stop();
            }
        },
        {
            name: "builds a stable unavailable capability map",
            run() {
                const state = unavailableAgentCapabilities("connection refused");
                assertEqual(state.llm, "unavailable");
                assertEqual(state.capabilities.fit_ingestion, false);
                assertEqual(state.reason, "connection refused");
            }
        }
    ]
};

function fakeResponse(payload, status = 200) {
    return { ok: status < 400, status, async json() { return payload; } };
}
