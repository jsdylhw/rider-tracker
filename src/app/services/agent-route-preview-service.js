import { createAgentApiClient } from "../../adapters/agent/personal-fit-agent-client.js";
import { createAgentRouteDraftStorage } from "../../adapters/storage/agent-route-draft-storage.js";
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
    agentClient = createAgentApiClient(),
    draftStorage = createAgentRouteDraftStorage()
}) {
    let currentDraft = draftStorage.load();

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
            let turnResult = await agentClient.chat(request);
            if (isRouteActivationOnly(turnResult)) {
                turnResult = await agentClient.chat("请继续执行刚才的路线规划请求，并返回可选择的路线候选。");
            }
            if (!operations.isCurrent(requestId) || store.getState().route !== loadingRoute) return null;
            if (operations.discardAfterRideStart("骑行已开始，已忽略未完成的 AI 路线。")) return null;
            const draft = saveDraft(parseAgentRouteDraft(turnResult));
            operations.clearRouteLoading(`Agent 已返回 ${draft.candidates.length} 条路线候选，请先预览再最终确认。`);
            return draft;
        } catch (error) {
            if (operations.isCurrent(requestId) && store.getState().route === loadingRoute) {
                operations.clearRouteLoading(`AI 路线处理失败：${extractErrorMessage(error)}`);
            }
            throw error;
        }
    }

    async function restoreAgentRouteDraft() {
        if (!currentDraft?.planId) return null;
        try {
            const draft = await runCommand("get");
            commitActiveRoute(draft, restoreStatus(draft));
            return draft;
        } catch {
            commitActiveRoute(currentDraft, restoreStatus(currentDraft));
            return currentDraft;
        }
    }

    async function previewAgentRoute(candidateId) {
        ensureDraft();
        const draft = await runCommand("select", { candidate_id: candidateId });
        commitCandidateRoute(draft, candidateId, true, "正在预览");
        return draft;
    }

    async function confirmAgentRoute(candidateId) {
        ensureDraft();
        const draft = await runCommand("confirm", { candidate_id: candidateId });
        const route = commitCandidateRoute(draft, candidateId, false, "已确认");
        return { draft, route };
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
        commitActiveRoute(draft, "已按所选 Strava 路段生成新候选，请检查地图后确认。");
        return draft;
    }

    async function reverseAgentRoute() {
        ensureDraft();
        const draft = await runCommand("reverse", { candidate_id: activeCandidateId(currentDraft) });
        commitActiveRoute(draft, "已反转当前 AI 路线，请检查地图后确认。");
        return draft;
    }

    async function undoAgentRoute() {
        ensureDraft();
        const draft = await runCommand("undo");
        commitActiveRoute(draft, "已撤销上一版 AI 路线修改。");
        return draft;
    }

    async function runCommand(operation, input = {}) {
        if (!operations.ensureRouteEditingAllowed()) return currentDraft;
        const response = await agentClient.routePlanCommand(operation, {
            plan_id: currentDraft?.planId,
            ...input
        });
        return saveDraft(parseAgentRouteDraft({
            answer: response.answer,
            status: "completed",
            presentations: response.presentations
        }));
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
        draftStorage.save(draft);
        return draft;
    }

    function ensureDraft() {
        if (!currentDraft?.planId) throw new Error("请先让 Agent 生成路线候选。");
    }

    return {
        planAgentRoutes,
        restoreAgentRouteDraft,
        previewAgentRoute,
        confirmAgentRoute,
        exploreAgentRouteSegments,
        composeAgentRouteSegments,
        reverseAgentRoute,
        undoAgentRoute,
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

function restoreStatus(draft) {
    return draft.planningStatus === "confirmed"
        ? "已恢复上次确认的 AI 虚拟路线。"
        : "已恢复上次未确认的 AI 路线草稿。";
}
