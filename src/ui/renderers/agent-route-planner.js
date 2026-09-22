import { createAgentSessionControls } from "../agent/agent-session-controls.js";
import { capabilityMessage } from "../../domain/agent/agent-capabilities.js";

export function createAgentRoutePlanner({
    elements,
    agentSessionClient,
    onRestoreAgentRouteSession,
    onPlanAgentRoutes,
    onPreviewAgentRoute,
    onConfirmAgentRoute,
    onExploreAgentRouteSegments,
    onComposeAgentRouteSegments,
    onReverseAgentRoute,
    onUndoAgentRoute,
    progressClock = globalThis,
}) {
    const documentRef = elements.aiRoutePanel?.ownerDocument ?? globalThis.document;
    const listeners = [];
    let initialized = false;
    let lastState = null;
    let currentDraft = null;
    let requestSequence = 0;
    let isBusy = false;
    let stopActiveProgress = null;
    let selectedSegmentIds = [];
    let restoringSession = false;
    let lastHandoff = null;
    const sessions = createAgentSessionControls({
        container: documentRef?.getElementById?.("aiRouteSessions"), client: agentSessionClient, kind: "route_plan",
        isLocked: () => lastState?.liveRide?.isActive === true,
        onBusy(value) { restoringSession = value; setBusy(value); renderCandidates(); },
        async onLoad(detail) {
            const draft = await onRestoreAgentRouteSession(detail);
            requestSequence += 1;
            currentDraft = draft;
            selectedSegmentIds = [];
            if (elements.aiRouteProgress) elements.aiRouteProgress.hidden = true;
            elements.aiRouteMessages.replaceChildren();
            for (const turn of detail.turns) {
                if (turn.message) addMessage("user", turn.message.split("\n\n这是 Rider Tracker")[0].split("\n\n当前路线计划")[0]);
                if (turn.response?.answer) addMessage("agent", turn.response.answer);
            }
            if (!detail.turns.length) addMessage("agent", "告诉我起点、距离和偏好，我会生成路线候选。");
            renderDraft();
        }
    });

    function listen(element, type, handler) {
        element?.addEventListener(type, handler);
        if (element) listeners.push(() => element.removeEventListener?.(type, handler));
    }

    function bindEvents() {
        listen(elements.aiRouteComposer, "submit", (event) => {
            event.preventDefault();
            void sendMessage(elements.aiRouteMessageInput?.value);
        });
        elements.aiRoutePromptButtons?.forEach((button) => {
            listen(button, "click", () => void sendMessage(button.dataset.aiRoutePrompt));
        });
        listen(elements.aiRouteExploreSegmentsBtn, "click", () => void runDraftAction(
            "正在查询当前路线附近的 Strava 热门路段……",
            () => onExploreAgentRouteSegments?.(activeCandidateId()),
            "已更新 Strava 路段池，可以按顺序选择路段。"
        ));
        listen(elements.aiRouteReverseBtn, "click", () => void runDraftAction(
            "正在反转当前路线……", onReverseAgentRoute, "已反转当前路线，请检查地图后确认。"
        ));
        listen(elements.aiRouteUndoBtn, "click", () => void runDraftAction(
            "正在撤销上一版修改……", onUndoAgentRoute, "已恢复上一版路线。"
        ));
        listen(elements.aiRouteClearSegmentsBtn, "click", () => {
            selectedSegmentIds = [];
            renderSegments();
        });
        listen(elements.aiRouteComposeSegmentsBtn, "click", () => void composeSelectedSegments());
    }

    function render(state) {
        lastState = state;
        if (state.agentRouteSession && state.agentRouteSession !== lastHandoff) {
            lastHandoff = state.agentRouteSession;
            requestSequence += 1;
            stopActiveProgress?.();
            if (elements.aiRouteProgress) elements.aiRouteProgress.hidden = true;
            sessions?.adopt(lastHandoff);
            elements.aiRouteMessages?.replaceChildren();
            for (const turn of lastHandoff.turns) {
                if (turn.message) addMessage("user", turn.message);
                if (turn.response?.answer) addMessage("agent", turn.response.answer);
            }
        }
        if (state.agentRouteDraft && state.agentRouteDraft !== currentDraft) {
            currentDraft = state.agentRouteDraft;
            selectedSegmentIds = [];
            renderDraft();
        }
        if (!initialized && elements.aiRouteMessages && elements.aiRouteCandidates) {
            initialized = true;
            if (!lastHandoff) void sessions?.restore();
            addMessage("agent", "告诉我起点、距离和偏好，我会生成真实路线候选。先预览，再继续修改或最终确认；无海拔虚拟路线适合配合 ERG 骑行。");
            renderDraft();
        } else {
            updateCandidateSelection(state?.route?.agentCandidateId);
        }
        updateDisabledState();
    }

    async function sendMessage(text) {
        const normalized = String(text ?? "").trim();
        if (!isAiRouteAvailable()) {
            addMessage("agent", unavailableMessage());
            return;
        }
        if (!normalized || isLocked()) return;
        requestSequence += 1;
        const sequence = requestSequence;
        addMessage("user", normalized);
        const progress = startProgressUpdates(sequence);
        stopActiveProgress = progress.stop;
        if (elements.aiRouteMessageInput) elements.aiRouteMessageInput.value = "";
        setBusy(true);
        try {
            const draft = await onPlanAgentRoutes?.(normalized, { onProgress: progress.update });
            void sessions?.refreshList();
            if (sequence !== requestSequence) return;
            if (!draft) {
                progress.finish("本次请求已结束，未更新路线");
                return;
            }
            progress.finish(draft.clarificationRequired ? "等待补充信息" : draft.dailyItinerary
                ? draft.candidates.some(c => c.dayStatus === "failed") ? "行程已保存，请查看当天失败原因"
                    : draft.candidates.some(c => c.dayStatus === "ready") ? "当天路线已更新，其他天可继续生成" : "多日草案已保存，可按天生成路线"
                : "处理完成");
            if (draft.clarificationRequired) {
                addMessage("agent", draft.answer);
                return;
            }
            currentDraft = draft;
            selectedSegmentIds = [];
            addMessage("agent", formatRouteDraftAnswer(draft));
            renderDraft();
        } catch (error) {
            if (sequence !== requestSequence) return;
            progress.finish("本次处理未完成");
            addMessage("agent", `路线处理失败：${error?.message || "请确认 Personal FIT Agent 已启动后重试。"}`);
        } finally {
            progress.stop();
            stopActiveProgress = null;
            if (sequence === requestSequence) {
                setBusy(false);
                renderDraft();
            }
        }
    }

    async function runDraftAction(pendingText, action, successText) {
        if (!currentDraft || isLocked()) return;
        const pending = addMessage("agent", pendingText, { pending: true });
        setBusy(true);
        try {
            const draft = await action?.();
            pending.remove?.();
            if (!draft) return;
            currentDraft = draft;
            selectedSegmentIds = selectedSegmentIds.filter((id) => (
                availableSegments().some((segment) => segment.segmentId === id)
            ));
            addMessage("agent", draft.operationError ? `当天生成失败：${draft.operationError.message}` : successText);
            renderDraft();
        } catch (error) {
            pending.remove?.();
            addMessage("agent", `操作失败：${error?.message || "请重试。"}`);
        } finally {
            setBusy(false);
            renderDraft();
        }
    }

    async function composeSelectedSegments() {
        if (selectedSegmentIds.length === 0) return;
        const segments = selectedSegmentIds.map((segmentId) => ({ segment_id: segmentId, direction: "auto" }));
        const names = selectedSegmentIds.map((id) => currentDraft.segments.find((item) => item.segmentId === id)?.name).filter(Boolean);
        await runDraftAction(
            `正在按 ${names.join(" → ")} 的顺序拼接路线……`,
            () => onComposeAgentRouteSegments?.(segments, { candidateName: names.join(" + ") }),
            "已生成路段拼接候选，请检查连接路线后最终确认。"
        );
    }

    function renderDraft() {
        renderCandidates();
        renderSegments();
        updateDisabledState();
    }

    function renderCandidates() {
        if (!elements.aiRouteCandidates) return;
        const selectedId = lastState?.route?.agentCandidateId || activeCandidateId();
        const candidates = currentDraft?.candidates ?? [];
        elements.aiRouteCandidates.replaceChildren(
            ...candidates.map((candidate) => createCandidateCard(candidate, selectedId))
        );
        if (elements.aiRouteResultTitle) {
            elements.aiRouteResultTitle.textContent = candidates.length
                ? currentDraft.dailyItinerary ? `骑行行程 · ${candidates.length} 天 · 已生成 ${candidates.filter(c => c.dayStatus === "ready").length} 天` : `Agent 路线候选 · ${candidates.length} 条`
                : "等待生成路线";
        }
        updateResultStatus(selectedId);
    }

    function createCandidateCard(candidate, selectedId) {
        const card = documentRef.createElement("article");
        card.className = "ai-route-candidate";
        card.dataset.candidateId = candidate.candidateId;
        card.classList.toggle("is-selected", candidate.candidateId === selectedId);
        const copy = documentRef.createElement("div");
        const title = documentRef.createElement("strong");
        title.textContent = currentDraft?.dailyItinerary ? `第 ${candidate.day} 天 · ${candidate.name}` : candidate.name;
        const metrics = documentRef.createElement("span");
        metrics.textContent = candidateMetrics(candidate);
        if (currentDraft?.dailyItinerary) {
            const labels = { pending: "待生成", generating: "生成中", ready: "已生成", failed: "生成失败", needs_regeneration: "待重新生成" };
            metrics.textContent = `${labels[candidate.dayStatus] || "待生成"} · ${candidate.previousRoute ? `上次成功路线：${candidateMetrics(candidate)}` : candidate.dayStatus === "ready" ? candidateMetrics(candidate) : "地图里程与时间待验证"}`;
        }
        const description = documentRef.createElement("p");
        description.textContent = candidate.description || "请预览地图，选择适合的路线。";
        if (currentDraft?.dailyItinerary) {
            description.textContent = (candidate.previousRoute ? "当前要求：" : "") + candidate.pointNames.join(" → ")
                + (candidate.previousRoute ? `；上次路线：${candidate.previousPointNames.join(" → ")}（仅供预览）` : "")
                + (candidate.distanceRangeKm ? `；目标 ${candidate.distanceRangeKm.join("–")} km` : candidate.targetDistanceKm ? `；目标 ${candidate.targetDistanceKm} km` : "；未设距离目标")
                + (candidate.dayError ? `；${candidate.dayError}` : "")
                + (candidate.connectionWarning ? `；${candidate.connectionWarning}` : "");
        }
        copy.append(title, metrics, description);
        if (candidate.warnings?.length) {
            const warnings = documentRef.createElement("p");
            warnings.textContent = `提示：${candidate.warnings.join("；")}`;
            copy.append(warnings);
        }

        const actions = documentRef.createElement("div");
        actions.className = "ai-route-candidate-actions";
        const preview = createButton(candidate.candidateId === selectedId ? "正在预览" : "预览", "secondary");
        if (currentDraft?.dailyItinerary && candidate.dayStatus !== "ready") preview.textContent = candidate.previousRoute ? "预览上次路线" : "选择当天";
        preview.disabled = isLocked();
        preview.addEventListener("click", () => void previewCandidate(candidate));
        const confirm = createButton(candidate.confirmed ? "已确认" : "最终确认", "primary");
        confirm.disabled = isLocked() || candidate.confirmed || !!(currentDraft?.dailyItinerary && (candidate.dayStatus !== "ready" || !!candidate.connectionWarning));
        confirm.addEventListener("click", () => void confirmCandidate(candidate));
        actions.append(preview, confirm);
        if (currentDraft?.dailyItinerary) {
            const generate = createButton(candidate.dayStatus === "ready" ? "重新生成当天" : "生成当天路线", "primary");
            generate.disabled = isLocked();
            generate.addEventListener("click", () => void runDraftAction(`正在计算第 ${candidate.day} 天的骑行路线…`,
                () => onPreviewAgentRoute?.(candidate.candidateId, { generate: true }), "当天处理已结束，请查看状态和地图里程。"));
            actions.append(generate);
        }
        card.append(copy, actions);
        return card;
    }

    function createButton(text, variant) {
        const button = documentRef.createElement("button");
        button.type = "button";
        button.className = `btn ${variant}`;
        button.textContent = text;
        return button;
    }

    async function previewCandidate(candidate) {
        await runDraftAction(
            `正在切换到“${candidate.name}”……`,
            () => onPreviewAgentRoute?.(candidate.candidateId),
            candidate.previousRoute ? "正在预览上次成功路线，尚未完成本次生成，不能确认。" : currentDraft?.dailyItinerary && candidate.dayStatus !== "ready" ? `已选择第 ${candidate.day} 天，可输入修改建议或生成当天路线。` : `已预览“${candidate.name}”。可以继续用自然语言修改，或点击最终确认。`
        );
    }

    async function confirmCandidate(candidate) {
        if (isLocked()) return;
        setBusy(true);
        try {
            const result = await onConfirmAgentRoute?.(candidate.candidateId);
            if (!result?.draft) return;
            currentDraft = result.draft;
            addMessage("agent", `已确认“${candidate.name}”。路线无海拔、坡度恒为 0，现在可以选择 ERG 课表并开始骑行。`);
            renderDraft();
        } catch (error) {
            addMessage("agent", `确认失败：${error?.message || "请重试。"}`);
        } finally {
            setBusy(false);
            renderDraft();
        }
    }

    function renderSegments() {
        const segments = availableSegments();
        if (elements.aiRouteSegmentPanel) elements.aiRouteSegmentPanel.hidden = segments.length === 0;
        if (!elements.aiRouteSegmentList) return;
        elements.aiRouteSegmentList.replaceChildren(...segments.map((segment) => {
            const button = documentRef.createElement("button");
            button.type = "button";
            button.className = "ai-route-segment-card";
            button.dataset.segmentId = String(segment.segmentId);
            const order = selectedSegmentIds.indexOf(segment.segmentId);
            button.classList.toggle("is-selected", order >= 0);
            const title = documentRef.createElement("strong");
            title.textContent = `${order >= 0 ? `${order + 1}. ` : ""}${segment.name}`;
            const meta = documentRef.createElement("span");
            meta.textContent = segmentMetrics(segment);
            button.append(title, meta);
            button.addEventListener("click", () => toggleSegment(segment.segmentId));
            return button;
        }));
        renderSegmentSelection();
    }

    function toggleSegment(segmentId) {
        const selectedIndex = selectedSegmentIds.indexOf(segmentId);
        if (selectedIndex >= 0) {
            selectedSegmentIds.splice(selectedIndex, 1);
        } else if (selectedSegmentIds.length < 3) {
            selectedSegmentIds.push(segmentId);
        } else {
            addMessage("agent", "一次最多选择 3 个 Strava 路段，请先取消一个已选路段。");
        }
        renderSegments();
    }

    function renderSegmentSelection() {
        const names = selectedSegmentIds.map((id) => currentDraft?.segments?.find((item) => item.segmentId === id)?.name).filter(Boolean);
        if (elements.aiRouteSegmentSelection) {
            elements.aiRouteSegmentSelection.textContent = names.length
                ? `拼接顺序：${names.join(" → ")}`
                : "尚未选择路段";
        }
        if (elements.aiRouteComposeSegmentsBtn) {
            const unsupported = currentDraft?.countryCode !== "CN";
            elements.aiRouteComposeSegmentsBtn.disabled = isLocked() || names.length === 0 || unsupported;
            elements.aiRouteComposeSegmentsBtn.title = unsupported ? "路段拼接当前只支持中国大陆路线" : "";
        }
    }

    function updateCandidateSelection(selectedId) {
        elements.aiRouteCandidates?.querySelectorAll?.("[data-candidate-id]").forEach((card) => {
            card.classList.toggle("is-selected", card.dataset.candidateId === selectedId);
        });
        updateResultStatus(selectedId);
    }

    function updateResultStatus(selectedId) {
        if (!elements.aiRouteResultStatus) return;
        if (!isAiRouteAvailable()) {
            elements.aiRouteResultStatus.textContent = unavailableMessage();
            return;
        }
        const candidate = currentDraft?.candidates?.find((item) => item.candidateId === selectedId);
        if (currentDraft?.dailyItinerary) {
            elements.aiRouteResultStatus.textContent = candidate ? `当前选中第 ${candidate.day} 天；可生成路线或在左侧修改当天要求。` : "请选择一天";
            return;
        }
        elements.aiRouteResultStatus.textContent = !candidate
            ? "等待生成或选择"
            : currentDraft.planningStatus === "confirmed"
                ? `已确认：${candidate.name}`
                : `正在预览：${candidate.name}`;
    }

    function addMessage(role, text, { pending = false } = {}) {
        const article = documentRef.createElement("article");
        article.className = `ai-route-message is-${role}${pending ? " is-pending" : ""}`;
        const label = documentRef.createElement("span");
        label.textContent = role === "user" ? "你" : "Agent";
        const body = documentRef.createElement("p");
        body.textContent = text;
        article.messageBody = body;
        article.append(label, body);
        elements.aiRouteMessages?.append(article);
        if (elements.aiRouteMessages) elements.aiRouteMessages.scrollTop = elements.aiRouteMessages.scrollHeight;
        return article;
    }

    function startProgressUpdates(sequence) {
        const now = () => progressClock.now?.() ?? Date.now();
        const startedAt = now();
        const labels = {
            reasoning: "分析需求与规划下一步",
            search_cycling_routes: "搜索骑行地点与线路资料",
            prepare_route_materials: "定位地点、检查可用路段并准备候选线路",
            create_route_plan: "计算道路路线并校验候选",
            create_itinerary_plan: "保存多日骑行草案",
            update_route_plan: "重新计算并校验修改后的路线",
            request_route_clarification: "整理需要补充的信息",
        };
        const stages = new Map();
        if (elements.aiRouteProgress) elements.aiRouteProgress.hidden = false;
        let current = "请求已发送，等待规划进度";
        let finished = false;
        const renderProgress = () => {
            if (sequence !== requestSequence) return;
            const elapsed = Math.max(0, Math.floor((now() - startedAt) / 1000));
            if (elements.aiRouteProgressStatus) elements.aiRouteProgressStatus.textContent = current;
            if (elements.aiRouteProgressElapsed) elements.aiRouteProgressElapsed.textContent = `${elapsed} 秒`;
            elements.aiRouteProgressSteps?.replaceChildren(...[...stages].map(([stage, status]) => {
                const item = documentRef.createElement("li");
                item.dataset.status = status;
                const state = { running: "处理中", completed: "已完成", failed: "未完成" }[status];
                item.textContent = `${labels[stage]} · ${state}`;
                return item;
            }));
        };
        const timer = progressClock.setInterval?.(renderProgress, 5_000);
        const stop = () => { finished = true; progressClock.clearInterval?.(timer); };
        renderProgress();
        return {
            stop,
            update(event) {
                if (finished || sequence !== requestSequence) return;
                if (event.stage === "map_retry") {
                    current = event.status === "running" ? "地图服务繁忙，正在等待重试" : "正在重新请求地图服务";
                    renderProgress();
                    return;
                }
                if (!labels[event.stage]) return;
                if (!["running", "completed", "failed"].includes(event.status)) return;
                const label = labels[event.stage];
                if (event.stage !== "reasoning") stages.set(event.stage, event.status);
                if (event.status === "running") current = `正在处理：${label}`;
                else if (event.status === "completed") {
                    current = "等待下一步处理";
                } else if (event.status === "failed") {
                    current = "正在判断是否可以恢复";
                }
                renderProgress();
            },
            finish(text) {
                current = text;
                renderProgress();
                stop();
            },
        };
    }

    function activeCandidateId() {
        return currentDraft?.candidates?.find((item) => item.active)?.candidateId
            || lastState?.route?.agentCandidateId
            || currentDraft?.candidates?.[0]?.candidateId;
    }

    function availableSegments() {
        const candidate = currentDraft?.candidates?.find((item) => item.candidateId === activeCandidateId());
        const targetId = candidate?.parentCandidateId || candidate?.candidateId;
        return (currentDraft?.segments ?? []).filter((segment) => (
            !segment.candidateIds?.length || segment.candidateIds.includes(targetId)
        ));
    }

    function isLocked() {
        return !isAiRouteAvailable()
            || isBusy || lastState?.liveRide?.isActive === true || lastState?.route?.isLoading === true;
    }

    function isAiRouteAvailable() {
        return lastState?.agentCapabilities === undefined
            || lastState.agentCapabilities?.capabilities?.ai_route_planning === true;
    }

    function unavailableMessage() {
        const availability = lastState?.agentCapabilities;
        const reason = capabilityMessage(availability, "ai_route_planning");
        return `${reason} GPX、本地保存路线和已导入的 Strava 路线仍可使用。`;
    }

    function setBusy(busy) {
        isBusy = busy;
        if (!restoringSession) sessions?.setBlocked(busy);
        const locked = !isAiRouteAvailable()
            || busy || lastState?.liveRide?.isActive === true || lastState?.route?.isLoading === true;
        if (elements.aiRouteMessageInput) elements.aiRouteMessageInput.disabled = locked;
        if (elements.aiRouteSendBtn) {
            elements.aiRouteSendBtn.disabled = locked;
            elements.aiRouteSendBtn.textContent = busy ? "处理中..." : currentDraft ? "修改路线" : "生成候选";
        }
        elements.aiRoutePromptButtons?.forEach((button) => { button.disabled = locked; });
        for (const button of [elements.aiRouteReverseBtn, elements.aiRouteUndoBtn]) {
            if (button) button.disabled = locked || !currentDraft || (currentDraft.dailyItinerary && button === elements.aiRouteReverseBtn);
        }
        if (elements.aiRouteExploreSegmentsBtn) {
            const stravaAvailable = isStravaAvailable();
            elements.aiRouteExploreSegmentsBtn.disabled = locked || !currentDraft || currentDraft.dailyItinerary || !stravaAvailable;
            elements.aiRouteExploreSegmentsBtn.title = stravaAvailable
                ? ""
                : capabilityMessage(lastState?.agentCapabilities, "strava");
        }
    }

    function isStravaAvailable() {
        return lastState?.agentCapabilities === undefined
            || lastState.agentCapabilities?.capabilities?.strava === true;
    }

    function updateDisabledState() {
        setBusy(isBusy);
        renderSegmentSelection();
    }

    function destroy() {
        requestSequence += 1;
        stopActiveProgress?.();
        sessions?.destroy();
        listeners.splice(0).forEach((remove) => remove());
    }

    return { bindEvents, render, sendMessage, destroy };
}

function candidateMetrics(candidate) {
    const values = [];
    if (candidate.distanceKm) values.push(`${candidate.distanceKm.toFixed(1)} km`);
    if (candidate.durationMinutes) values.push(`${candidate.durationLabel || "虚拟骑行约"} ${Math.round(candidate.durationMinutes)} 分钟`);
    if (candidate.estimatedAscentMeters !== null && candidate.estimatedAscentMeters !== undefined) {
        values.push(`估算爬升 ${Math.round(candidate.estimatedAscentMeters)} m（仅供参考）`);
    }
    values.push("平坡模拟 · ERG 适用");
    return values.join(" · ");
}

function segmentMetrics(segment) {
    const values = [];
    if (segment.distanceKm) values.push(`${segment.distanceKm.toFixed(1)} km`);
    if (segment.averageGradePercent !== null) values.push(`均坡 ${segment.averageGradePercent.toFixed(1)}%`);
    if (segment.distanceToRouteKm !== null) values.push(`距路线 ${segment.distanceToRouteKm.toFixed(1)} km`);
    return values.join(" · ");
}

function formatRouteDraftAnswer(draft) {
    const candidates = draft?.candidates ?? [];
    const rejected = draft?.rejectedCandidates ?? [];
    const active = candidates.find((item) => item.active) ?? candidates[0];
    if (!active) return "暂时没有生成可用路线，请调整地点或距离后重试。";
    const metrics = [];
    if (active.distanceKm) metrics.push(`${active.distanceKm.toFixed(1)} km`);
    if (active.durationMinutes) metrics.push(`约 ${Math.round(active.durationMinutes)} 分钟`);
    const rejectedSummary = rejected.length
        ? `另有 ${rejected.length} 条未能生成：${rejected.map((item) => `${item.name}（${item.reason}）`).join("；")}`
        : "";
    return [
        `已生成 ${candidates.length} 条路线候选。`,
        rejectedSummary,
        "",
        `当前预览：${active.name}`,
        metrics.length ? `距离与用时：${metrics.join(" · ")}` : "",
        active.warnings?.length ? `路线提示：${active.warnings.join("；")}` : "",
        "",
        "可以切换候选、继续输入修改要求，或最终确认。",
    ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join("\n");
}
