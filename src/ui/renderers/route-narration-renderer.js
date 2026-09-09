export function createRouteNarrationRenderer({
    elements,
    onLoad,
    onClose,
    onPrevious,
    onNext,
    onRetry
} = {}) {
    const failedPhotoNames = new Set();
    let activePhotoName = "";
    elements.routeNarrationLoadBtn?.addEventListener("click", () => onLoad?.());
    elements.routeNarrationCloseBtn?.addEventListener("click", () => onClose?.());
    elements.routeNarrationPreviousBtn?.addEventListener("click", () => onPrevious?.());
    elements.routeNarrationNextBtn?.addEventListener("click", () => onNext?.());
    elements.routeNarrationRetryBtn?.addEventListener("click", () => onRetry?.());
    elements.routeNarrationPhoto?.addEventListener("error", () => {
        if (activePhotoName) failedPhotoNames.add(activePhotoName);
        if (elements.routeNarrationMedia) elements.routeNarrationMedia.hidden = true;
    });

    function render(state, { visible = false, agentCapabilities = null } = {}) {
        const panel = elements.routeNarrationHudCard;
        if (!panel) return;

        const status = state?.status ?? "idle";
        panel.hidden = !visible || ["idle", "closed"].includes(status);
        if (panel.hidden) return;

        resetActions(elements);
        if (agentCapabilities !== null && agentCapabilities?.capabilities?.route_narration !== true) {
            hideMedia(elements);
            renderUnavailable(elements, agentCapabilities);
        } else if (status === "prompt") {
            hideMedia(elements);
            renderPrompt(elements);
        } else if (status === "loading") {
            failedPhotoNames.clear();
            activePhotoName = "";
            hideMedia(elements);
            renderLoading(elements);
        } else if (status === "failed") {
            hideMedia(elements);
            renderFailure(elements, state);
        } else {
            renderReady(elements, state);
            const photoName = renderMedia(elements, state?.item?.media, failedPhotoNames, activePhotoName);
            if (photoName !== null) activePhotoName = photoName;
        }
    }

    return { render };
}

function renderMedia(elements, media, failedPhotoNames, activePhotoName) {
    const photoName = media?.type === "google_place_photo" ? media.photo_name : "";
    if (!photoName || failedPhotoNames.has(photoName)) {
        hideMedia(elements);
        return "";
    }
    if (elements.routeNarrationMedia) elements.routeNarrationMedia.hidden = false;
    if (elements.routeNarrationPhoto && photoName !== activePhotoName) {
        elements.routeNarrationPhoto.alt = "沿途景点照片";
        elements.routeNarrationPhoto.src = buildPhotoUrl(photoName);
    }
    const attribution = media.author_attributions?.find((item) => item.display_name) ?? null;
    const credit = attribution?.display_name
        ? `照片：${attribution.display_name}`
        : "Google Places 照片";
    const href = attribution?.uri || media.source_url || "";
    setText(elements.routeNarrationPhotoCredit, credit);
    if (href) elements.routeNarrationPhotoCredit?.setAttribute("href", href);
    else elements.routeNarrationPhotoCredit?.removeAttribute?.("href");
    return photoName;
}

function hideMedia(elements) {
    if (elements.routeNarrationMedia) elements.routeNarrationMedia.hidden = true;
}

function buildPhotoUrl(photoName) {
    return `/api/route-narrations/photo?name=${encodeURIComponent(photoName)}&max_width=720`;
}

function renderUnavailable(elements, availability) {
    setText(elements.routeNarrationStatus, "路线讲解 · 不可用");
    setText(elements.routeNarrationTitle, "沿途讲解未启用");
    const summary = availability?.backend !== "available"
        ? "Training Agent 当前未运行；街景和骑行不受影响。"
        : availability?.llm === "disabled"
            ? "AI 功能已关闭；街景和骑行不受影响。"
            : "尚未配置大模型 API；街景和骑行不受影响。";
    setText(elements.routeNarrationSummary, summary);
}

function resetActions(elements) {
    for (const element of [
        elements.routeNarrationLoadBtn,
        elements.routeNarrationRetryBtn,
        elements.routeNarrationPreviousBtn,
        elements.routeNarrationNextBtn
    ]) {
        if (element) element.hidden = true;
    }
    if (elements.routeNarrationCloseBtn) elements.routeNarrationCloseBtn.hidden = false;
    if (elements.routeNarrationPosition) elements.routeNarrationPosition.hidden = true;
}

function renderPrompt(elements) {
    setText(elements.routeNarrationStatus, "路线讲解");
    setText(elements.routeNarrationTitle, "加载沿途讲解？");
    setText(
        elements.routeNarrationSummary,
        "讲解 Agent 会搜索路线附近的地理、历史和人文资料，并为本次骑行准备一组沿途卡片。"
    );
    if (elements.routeNarrationLoadBtn) elements.routeNarrationLoadBtn.hidden = false;
}

function renderLoading(elements) {
    setText(elements.routeNarrationStatus, "路线讲解 · 准备中");
    setText(elements.routeNarrationTitle, "正在搜索沿途内容");
    setText(
        elements.routeNarrationSummary,
        "街景和骑行不会受到影响。讲解 Agent 正在检索并整理整条路线的卡片；返回页面后再次进入也不会重复请求。"
    );
}

function renderFailure(elements, state) {
    setText(elements.routeNarrationStatus, "路线讲解");
    setText(elements.routeNarrationTitle, "讲解准备失败");
    setText(elements.routeNarrationSummary, state.error || "暂时无法准备路线讲解，可以稍后重试。");
    if (elements.routeNarrationRetryBtn) elements.routeNarrationRetryBtn.hidden = false;
}

function renderReady(elements, state) {
    const item = state?.item;
    setText(elements.routeNarrationStatus, buildStatusText(state));
    setText(elements.routeNarrationTitle, item?.title || "沿途讲解已准备完成");
    setText(elements.routeNarrationSummary, item?.summary || "当前路线没有可展示的讲解内容。");
    if (elements.routeNarrationPosition) {
        elements.routeNarrationPosition.hidden = state.itemCount <= 0;
        elements.routeNarrationPosition.textContent = state.itemCount > 0
            ? `${state.itemIndex + 1} / ${state.itemCount}`
            : "";
    }
    if (elements.routeNarrationPreviousBtn) {
        elements.routeNarrationPreviousBtn.hidden = false;
        elements.routeNarrationPreviousBtn.disabled = !state.canMovePrevious;
    }
    if (elements.routeNarrationNextBtn) {
        elements.routeNarrationNextBtn.hidden = false;
        elements.routeNarrationNextBtn.disabled = !state.canMoveNext;
    }
}

function buildStatusText(state) {
    const distance = state.distanceToItemMeters;
    if (state.isAnnounced) return "路线讲解 · 已到达";
    if (!Number.isFinite(distance)) return "路线讲解";
    if (distance <= 0) return "路线讲解 · 当前地点";
    return `路线讲解 · 前方 ${formatDistance(distance)}`;
}

function setText(element, value) {
    if (element) element.textContent = value;
}

function formatDistance(distanceMeters) {
    if (distanceMeters >= 1000) return `${(distanceMeters / 1000).toFixed(1)} km`;
    return `${Math.max(0, Math.round(distanceMeters / 10) * 10)} m`;
}
