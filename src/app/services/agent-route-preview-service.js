import { buildRoute } from "../../domain/route/route-builder.js";
import { createAgentApiClient } from "../../adapters/agent/personal-fit-agent-client.js";
import {
    buildRiderRouteFromAgentCandidate,
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
    let routeSessionId = null;

    async function restoreAgentRouteSession(detail) {
        if (!operations.ensureRouteEditingAllowed()) throw new Error("骑行中不能切换路线会话");
        const requestId = operations.invalidateRequests();
        let draft = null;
        if (detail.route_reference) {
            const response = await agentClient.routePlanCommand("get", {
                // Restore the latest owned artifact, including a day saved
                // before an interrupted HTTP response. Old cards still use
                // exact revisions in openAgentRoute below.
                session_id: detail.session_id, plan_id: detail.route_reference.plan_id
            });
            draft = parseAgentRouteDraft({ ...response, status: "completed" });
        }
        if (!operations.isCurrent(requestId)) throw new Error("会话切换已被更新的操作替代");
        if (!operations.ensureRouteEditingAllowed()) throw new Error("骑行中不能切换路线会话");
        routeSessionId = detail.session_id;
        saveDraft(draft);
        if (draft) commitActiveRoute(draft, "已恢复会话路线");
        else if (store.getState().route?.agentPlanId) operations.commitRoute(buildRoute([]), "新路线会话");
        return draft;
    }

    async function openAgentRoute({ planId, revision, sessionId }) {
        if (!operations.ensureRouteEditingAllowed()) return null;
        const requestId = operations.invalidateRequests();
        const response = await agentClient.routePlanCommand("get", { plan_id: planId, session_id: sessionId, expected_revision: revision });
        if (!operations.isCurrent(requestId)) return null;
        if (operations.discardAfterRideStart("骑行已开始，已忽略打开路线请求。")) return null;
        const draft = parseAgentRouteDraft({ ...response, status: "completed" });
        if (draft.planId !== planId || draft.revision !== revision) {
            throw new Error("路线版本已变化，请在主对话重新获取草稿后打开。");
        }
        const detail = agentClient.getSession ? await agentClient.getSession(sessionId) : null;
        if (!operations.isCurrent(requestId)) return null;
        if (operations.discardAfterRideStart("骑行已开始，已忽略打开路线请求。")) return null;
        routeSessionId = sessionId;
        if (detail) agentClient.selectSession(sessionId);
        saveDraft(draft);
        if (detail) store.setState((state) => ({ ...state, agentRouteSession: detail }));
        commitActiveRoute(draft, "已打开路线草稿，请检查地图后确认。");
        return draft;
    }

    async function planAgentRoutes(message, { onProgress } = {}) {
        if (!operations.ensureRouteEditingAllowed()) return null;
        invalidateExploration?.();
        const { requestId, route: loadingRoute } = operations.beginRouteRequest(
            currentDraft ? "正在基于所选路线重新生成候选..." : "正在请求 Personal FIT Agent 生成路线候选..."
        );
        try {
            const request = currentDraft
                ? buildRouteRefinementRequest(message, currentDraft)
                : buildVirtualRouteRequest(message);
            const chatOptions = {
                ...(onProgress ? { onProgress: (event) => { if (operations.isCurrent(requestId)) onProgress(event); } } : {}),
                routeOptions: { include_elevation: false, include_ascent: true },
                ...(routeSessionId ? { sessionId: routeSessionId } : {}),
                requestMode: "route_plan",
                routeAction: currentDraft ? "refine" : "create",
                routeReference: currentDraft ? { plan_id: currentDraft.planId, revision: currentDraft.revision } : null
            };
            const turnResult = await agentClient.chat(request, chatOptions);
            if (!operations.isCurrent(requestId) || store.getState().route !== loadingRoute) return null;
            if (operations.discardAfterRideStart("骑行已开始，已忽略未完成的 AI 路线。")) return null;
            if (turnResult?.status === "clarification_required") {
                operations.clearRouteLoading(turnResult.answer);
                return { clarificationRequired: true, answer: turnResult.answer };
            }
            const draft = saveDraft(parseAgentRouteDraft(turnResult));
            const candidateId = activeCandidateId(draft);
            if (candidateId) {
                commitCandidateRoute(
                    draft,
                    candidateId,
                    true,
                    draft.dailyItinerary ? `已恢复 ${draft.candidates.length} 天骑行行程` : `Agent 已返回 ${draft.candidates.length} 条候选，正在预览首条`
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

    async function previewAgentRoute(candidateId, { generate = false } = {}) {
        ensureDraft();
        const draft = await runCommand(generate ? "generate_day" : "select", { candidate_id: candidateId });
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
            ...(routeSessionId ? { session_id: routeSessionId } : {}),
            ...input
        });
        if (!operations.isCurrent(requestId)) return null;
        if (operations.discardAfterRideStart("骑行已开始，已忽略未完成的 AI 路线操作。")) return null;
        const draft = saveDraft(parseAgentRouteDraft({
            ...response
        }));
        return { draft, response };
    }

    function commitActiveRoute(draft, statusText) {
        const candidateId = activeCandidateId(draft);
        if (!candidateId) return null;
        return commitCandidateRoute(draft, candidateId, draft.planningStatus !== "confirmed", statusText);
    }

    function commitCandidateRoute(draft, candidateId, isDraft, prefix) {
        const selected = draft.candidates.find((item) => item.candidateId === candidateId);
        if (draft.dailyItinerary && ((selected?.dayStatus !== "ready" && !selected?.previousRoute) || selected.coordinates.length < 2)) {
            operations.invalidateRequests();
            operations.commitRoute(buildRoute([]), "已选择当天草案，尚无可预览道路路线。");
            return null;
        }

        const built = buildRiderRouteFromAgentCandidate(draft, candidateId);
        const route = { ...built, isDraft: draft.dailyItinerary ? !selected.confirmed : isDraft };
        operations.invalidateRequests();
        operations.commitRoute(
            route,
            `${selected.previousRoute ? "正在预览上次成功路线（尚未完成本次生成）" : prefix} AI 虚拟路线：${route.name}，${formatNumber(route.totalDistanceMeters / 1000, 1)} km。`
            + (route.isDraft ? " 最终确认前不能开始骑行。" : " 无海拔，可直接配合 ERG 骑行。")
        );
        return route;
    }

    function saveDraft(draft) {
        currentDraft = draft;
        store.setState?.((state) => ({ ...state, agentRouteDraft: draft }));
        return draft;
    }

    function ensureDraft() {
        if (!currentDraft?.planId) throw new Error("请先让 Agent 生成路线候选。");
    }

    return {
        agentSessionClient: agentClient,
        restoreAgentRouteSession,
        openAgentRoute,
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
        "这是 Rider Tracker 的虚拟观景路线：多日骑行先调用 create_itinerary_plan 保存一套逐日草案，之后按天生成，不套用单日默认距离。仅单日规划：如果用户只给区域、距离或偏好等开放需求，应准备 3 条有实质区别的候选骨架，通过一次 create_route_plan 调用验证；使用材料准备时传 use_prepared_candidates=true，不重写 candidates；如果用户已经明确给出完整起终点或途经点顺序，则保持原顺序并可只生成 1 条。不要为每条候选分别调用工具；Google 爬升由服务端独立估算，仅供参考，不计算最大坡度；模拟坡度按 0 处理，配合 ERG 骑行。"
    ].filter(Boolean).join("\n\n");
}

function buildRouteRefinementRequest(message, draft) {
    if (draft.dailyItinerary) return [String(message || "").trim(),
        `当前多日骑行计划 ${draft.planId}，选中 ${draft.activeCandidateId}。只更新明确指定的一天；edit_day 保存修改，generate_day 生成当天路线，保留其他天。`].join("\n\n");
    return [
        String(message || "").trim(),
        `当前路线计划 ${draft.planId}。以当前选中路线为基准，结合修改建议重新准备并生成三条可预览候选，调用 create_route_plan 新建候选组，不要只修改一条。`,
        "同一区域修改时保留未被用户否定的起点、终点和路线意图；跨区域时不得用旧计划的 country_code 或途经点继续更新。",
        "这是平坡 ERG 虚拟路线，include_elevation 必须为 false；服务端独立估算爬升，仅供参考，不用于模拟或最大坡度。修改后返回可预览的路线候选。"
    ].filter(Boolean).join("\n\n");
}
