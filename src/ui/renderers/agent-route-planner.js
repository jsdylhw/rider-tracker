export function createAgentRoutePlanner({
    elements,
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
    let selectedSegmentIds = [];

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
        if (!initialized && elements.aiRouteMessages && elements.aiRouteCandidates) {
            initialized = true;
            addMessage("agent", "告诉我起点、距离和偏好，我会生成真实路线候选。先预览，再继续修改或最终确认；无海拔虚拟路线适合配合 ERG 骑行。");
            renderDraft();
        } else {
            updateCandidateSelection(state?.route?.agentCandidateId);
        }
        updateDisabledState();
    }

    async function sendMessage(text) {
        const normalized = String(text ?? "").trim();
        if (!normalized || isLocked()) return;
        requestSequence += 1;
        const sequence = requestSequence;
        addMessage("user", normalized);
        const pending = addMessage("agent", currentDraft
            ? "正在根据新要求增量修改当前路线……"
            : "正在检索地点并生成路线候选……", { pending: true });
        const stopProgress = startProgressUpdates(pending, Boolean(currentDraft));
        if (elements.aiRouteMessageInput) elements.aiRouteMessageInput.value = "";
        setBusy(true);
        try {
            const draft = await onPlanAgentRoutes?.(normalized);
            if (sequence !== requestSequence || !draft) return;
            pending.remove?.();
            currentDraft = draft;
            selectedSegmentIds = [];
            addMessage("agent", formatRouteDraftAnswer(draft));
            renderDraft();
        } catch (error) {
            pending.remove?.();
            addMessage("agent", `路线处理失败：${error?.message || "请确认 Personal FIT Agent 已启动后重试。"}`);
        } finally {
            stopProgress();
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
            addMessage("agent", successText);
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
                ? `Agent 路线候选 · ${candidates.length} 条`
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
        title.textContent = candidate.name;
        const metrics = documentRef.createElement("span");
        metrics.textContent = candidateMetrics(candidate);
        const description = documentRef.createElement("p");
        description.textContent = candidate.stravaSegments
            ? `已包含 Strava 路段：${candidate.stravaSegments}`
            : `算路来源：${candidate.provider || "Personal FIT Agent"}`;
        copy.append(title, metrics, description);

        const actions = documentRef.createElement("div");
        actions.className = "ai-route-candidate-actions";
        const preview = createButton(candidate.candidateId === selectedId ? "正在预览" : "预览", "secondary");
        preview.disabled = isLocked();
        preview.addEventListener("click", () => void previewCandidate(candidate));
        const confirm = createButton(candidate.confirmed ? "已确认" : "最终确认", "primary");
        confirm.disabled = isLocked() || candidate.confirmed;
        confirm.addEventListener("click", () => void confirmCandidate(candidate));
        actions.append(preview, confirm);
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
            `已预览“${candidate.name}”。可以继续用自然语言修改，或点击最终确认。`
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
        const candidate = currentDraft?.candidates?.find((item) => item.candidateId === selectedId);
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

    function startProgressUpdates(message, refining) {
        const now = () => progressClock.now?.() ?? Date.now();
        const startedAt = now();
        const stages = refining
            ? [
                [15, "正在解析修改要求并重新检索受影响的地点"],
                [35, "正在重新计算路线并校验距离"],
                [70, "正在检查路线材料和可用候选"],
            ]
            : [
                [15, "已理解路线偏好，正在检索候选地点"],
                [35, "正在调用地图服务计算真实道路路线"],
                [70, "正在校验候选距离并检查 Strava 路段"],
                [120, "外部地图服务响应较慢，仍在继续处理"],
            ];
        const update = () => {
            const elapsed = Math.max(0, Math.floor((now() - startedAt) / 1000));
            const stage = [...stages].reverse().find(([after]) => elapsed >= after)?.[1]
                || (refining ? "正在根据新要求增量修改当前路线" : "正在检索地点并生成路线候选");
            if (message?.messageBody) message.messageBody.textContent = `${stage}……已等待 ${elapsed} 秒`;
        };
        update();
        const timer = progressClock.setInterval?.(update, 5_000);
        return () => progressClock.clearInterval?.(timer);
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
        return isBusy || lastState?.liveRide?.isActive === true || lastState?.route?.isLoading === true;
    }

    function setBusy(busy) {
        isBusy = busy;
        const locked = busy || lastState?.liveRide?.isActive === true || lastState?.route?.isLoading === true;
        if (elements.aiRouteMessageInput) elements.aiRouteMessageInput.disabled = locked;
        if (elements.aiRouteSendBtn) {
            elements.aiRouteSendBtn.disabled = locked;
            elements.aiRouteSendBtn.textContent = busy ? "处理中..." : currentDraft ? "修改路线" : "生成候选";
        }
        elements.aiRoutePromptButtons?.forEach((button) => { button.disabled = locked; });
        for (const button of [elements.aiRouteExploreSegmentsBtn, elements.aiRouteReverseBtn, elements.aiRouteUndoBtn]) {
            if (button) button.disabled = locked || !currentDraft;
        }
    }

    function updateDisabledState() {
        setBusy(isBusy);
        renderSegmentSelection();
    }

    function destroy() {
        requestSequence += 1;
        listeners.splice(0).forEach((remove) => remove());
    }

    return { bindEvents, render, sendMessage, destroy };
}

function candidateMetrics(candidate) {
    const values = [];
    if (candidate.distanceKm) values.push(`${candidate.distanceKm.toFixed(1)} km`);
    if (candidate.durationMinutes) values.push(`虚拟骑行约 ${Math.round(candidate.durationMinutes)} 分钟`);
    values.push("无海拔 · ERG 适用");
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
    const active = candidates.find((item) => item.active) ?? candidates[0];
    if (!active) return "暂时没有生成可用路线，请调整地点或距离后重试。";
    const metrics = [];
    if (active.distanceKm) metrics.push(`${active.distanceKm.toFixed(1)} km`);
    if (active.durationMinutes) metrics.push(`约 ${Math.round(active.durationMinutes)} 分钟`);
    return [
        `已生成 ${candidates.length} 条路线候选。`,
        "",
        `当前预览：${active.name}`,
        metrics.length ? `距离与用时：${metrics.join(" · ")}` : "",
        "",
        "可以切换候选、继续输入修改要求，或最终确认。",
    ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join("\n");
}
