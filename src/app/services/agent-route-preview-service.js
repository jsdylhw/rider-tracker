import { createAgentApiClient } from "../../adapters/agent/personal-fit-agent-client.js";
import {
    buildRiderRouteFromAgentCandidate,
    isRouteActivationOnly,
    parseAgentRouteDraft
} from "../../domain/route/agent-route-contract.js";
import { formatNumber } from "../../shared/format.js";
import { extractErrorMessage } from "../../shared/utils/common.js";

export function createAgentRoutePreviewService({
    store,
    operations,
    invalidateExploration,
    agentClient = createAgentApiClient()
}) {
    let currentDraft = null;

    async function planAgentRoutes(message) {
        if (!operations.ensureRouteEditingAllowed()) return null;
        invalidateExploration?.();
        const { requestId, route: loadingRoute } = operations.beginRouteRequest(
            currentDraft ? "正在按新要求修改当前 AI 路线..." : "正在请求 Personal FIT Agent 生成路线候选..."
        );
        try {
            const request = currentDraft
                ? buildRouteRefinementRequest(message, currentDraft)
                : buildVirtualRouteRequest(message);
            const chatOptions = { routeOptions: { include_elevation: false } };
            let turnResult = await agentClient.chat(request, chatOptions);
            if (isRouteActivationOnly(turnResult)) {
                turnResult = await agentClient.chat(
                    "请继续执行刚才的路线规划请求，并返回可选择的路线候选。",
                    chatOptions
                );
            }
            if (!operations.isCurrent(requestId) || store.getState().route !== loadingRoute) return null;
            if (operations.discardAfterRideStart("骑行已开始，已忽略未完成的 AI 路线。")) return null;
            const draft = saveDraft(parseAgentRouteDraft(turnResult));
            const candidateId = activeCandidateId(draft);
            if (candidateId) {
                commitCandidateRoute(
                    draft,
                    candidateId,
                    true,
                    `Agent 已返回 ${draft.candidates.length} 条候选，正在预览首条`
                );
            } else {
                operations.clearRouteLoading(`Agent 已返回 ${draft.candidates.length} 条路线候选，请先预览再最终确认。`);
            }
            return draft;
        } catch (error) {
            if (operations.isCurrent(requestId) && store.getState().route === loadingRoute) {
                operations.clearRouteLoading(`AI 路线处理失败：${extractErrorMessage(error)}`);
            }
            throw error;
        }
    }

    async function previewAgentRoute(candidateId) {
        ensureDraft();
        const draft = await runCommand("select", { candidate_id: candidateId });
        if (!draft) return null;
        commitCandidateRoute(draft, candidateId, true, "正在预览");
        return draft;
    }

    async function confirmAgentRoute(candidateId) {
        ensureDraft();
        const previousRevision = currentDraft.revision;
        const pendingRoute = buildRiderRouteFromAgentCandidate(currentDraft, candidateId);
        const execution = await executeCommand("confirm", {
            candidate_id: candidateId,
            saved_route: confirmedRoutePayload(pendingRoute)
        });
        if (!execution?.response) return null;
        const { draft, response } = execution;
        if (
            draft.planningStatus !== "confirmed"
            || draft.confirmedCandidateId !== candidateId
            || draft.revision <= previousRevision
            || !response.saved_route?.id
        ) {
            throw new Error("路线确认或保存响应与当前候选不一致，已保留原路线，请重试。");
        }
        const saved = response.saved_route;
        const route = {
            ...pendingRoute,
            isDraft: false,
            agentMetadata: saved.route?.agentMetadata ?? pendingRoute.agentMetadata,
            savedRouteId: saved.id,
            savedRouteResumeDistanceMeters: saved.resumeDistanceMeters ?? 0
        };
        operations.invalidateRequests();
        operations.commitRoute(
            route,
            `已确认并保存 AI 虚拟路线：${route.name}，${formatNumber(route.totalDistanceMeters / 1000, 1)} km。`
        );
        return { draft, route, savedRoute: saved };
    }

    async function exploreAgentRouteSegments(candidateId) {
        ensureDraft();
        return runCommand("explore_segments", {
            candidate_id: candidateId || activeCandidateId(currentDraft),
            corridor_km: 5,
            max_segments: 12
        });
    }

    async function composeAgentRouteSegments(segments, { candidateName = "", targetDistanceKm = null } = {}) {
        ensureDraft();
        if (currentDraft.countryCode !== "CN") {
            throw new Error("Strava 路段拼接当前只支持中国大陆路线。");
        }
        const draft = await runCommand("compose_segments", {
            candidate_id: activeCandidateId(currentDraft),
            candidate_name: candidateName,
            target_distance_km: targetDistanceKm,
            segments
        });
        if (!draft) return null;
        commitActiveRoute(draft, "已按所选 Strava 路段生成新候选，请检查地图后确认。");
        return draft;
    }

    async function reverseAgentRoute() {
        ensureDraft();
        const draft = await runCommand("reverse", { candidate_id: activeCandidateId(currentDraft) });
        if (!draft) return null;
        commitActiveRoute(draft, "已反转当前 AI 路线，请检查地图后确认。");
        return draft;
    }

    async function undoAgentRoute() {
        ensureDraft();
        const draft = await runCommand("undo");
        if (!draft) return null;
        commitActiveRoute(draft, "已撤销上一版 AI 路线修改。");
        return draft;
    }

    async function runCommand(operation, input = {}) {
        const execution = await executeCommand(operation, input);
        return execution?.draft ?? null;
    }

    async function executeCommand(operation, input = {}) {
        if (!operations.ensureRouteEditingAllowed()) return { draft: currentDraft, response: null };
        const requestId = operations.invalidateRequests();
        const response = await agentClient.routePlanCommand(operation, {
            plan_id: currentDraft?.planId,
            expected_revision: currentDraft?.revision,
            ...input
        });
        if (!operations.isCurrent(requestId)) return null;
        if (operations.discardAfterRideStart("骑行已开始，已忽略未完成的 AI 路线操作。")) return null;
        const draft = saveDraft(parseAgentRouteDraft({
            answer: response.answer,
            status: "completed",
            route_plan: response.route_plan
        }));
        return { draft, response };
    }

    function commitActiveRoute(draft, statusText) {
        const candidateId = activeCandidateId(draft);
        if (!candidateId) return null;
        return commitCandidateRoute(draft, candidateId, draft.planningStatus !== "confirmed", statusText);
    }

    function commitCandidateRoute(draft, candidateId, isDraft, prefix) {
        const built = buildRiderRouteFromAgentCandidate(draft, candidateId);
        const route = { ...built, isDraft };
        operations.invalidateRequests();
        operations.commitRoute(
            route,
            `${prefix} AI 虚拟路线：${route.name}，${formatNumber(route.totalDistanceMeters / 1000, 1)} km。`
            + (isDraft ? " 最终确认前不能开始骑行。" : " 无海拔，可直接配合 ERG 骑行。")
        );
        return route;
    }

    function saveDraft(draft) {
        currentDraft = draft;
        return draft;
    }

    function ensureDraft() {
        if (!currentDraft?.planId) throw new Error("请先让 Agent 生成路线候选。");
    }

    return {
        planAgentRoutes,
        previewAgentRoute,
        confirmAgentRoute,
        exploreAgentRouteSegments,
        composeAgentRouteSegments,
        reverseAgentRoute,
        undoAgentRoute,
    };
}

function confirmedRoutePayload(route) {
    return {
        route,
        source: "agent",
        name: route.name,
        agentPlanId: route.agentPlanId,
        agentCandidateId: route.agentCandidateId,
        metadata: route.agentMetadata ?? {}
    };
}

function activeCandidateId(draft) {
    return draft?.candidates?.find((item) => item.active)?.candidateId
        || draft?.candidates?.[0]?.candidateId
        || null;
}

function buildVirtualRouteRequest(message) {
    return [
        String(message || "").trim(),
        "这是 Rider Tracker 的虚拟观景路线：请在一次 create_route_plan 调用的 candidates 数组中生成 2-3 条有实质区别的候选，不要为每条候选分别调用工具；不请求海拔，坡度按 0 处理；路线将配合 ERG 骑行。"
    ].filter(Boolean).join("\n\n");
}

function buildRouteRefinementRequest(message, draft) {
    return [
        String(message || "").trim(),
        `请基于当前路线计划 ${draft.planId} 和当前候选继续增量修改。`,
        "保留未被用户否定的起点、终点和路线意图；不要重新进行宽泛路线发现，除非用户明确要求换区域或重新规划。",
        "这是无海拔 ERG 虚拟路线，include_elevation 必须为 false。修改后返回可预览的路线候选。"
    ].filter(Boolean).join("\n\n");
}
