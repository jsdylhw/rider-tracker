import { deleteActivity, fetchActivityHistory, getActivity, renameActivity } from "../../adapters/storage/activity-history-client.js";
import { formatDuration, formatNumber } from "../../shared/format.js";
import { extractErrorMessage } from "../../shared/utils/common.js";

const DEFAULT_LIMIT = 20;

export function createActivityHistoryRenderer({
    containers = [],
    limit = DEFAULT_LIMIT,
    onStatus = () => {},
    onSummary = () => {},
    onOpenActivityDetail = () => {}
} = {}) {
    const mountedContainers = containers.filter(Boolean);
    let activities = [];
    let loading = false;
    let statusText = "";
    let page = { total: 0, hasMore: false };
    let filters = { sportType: "", source: "" };
    let bound = false;
    let requestGeneration = 0;
    let queuedRefresh = false;

    function bindEvents() {
        if (bound) return;
        bound = true;

        mountedContainers.forEach((container) => {
            container.addEventListener("click", (event) => {
                const actionTarget = event.target?.closest?.("[data-activity-action]");
                const action = actionTarget?.dataset?.activityAction;
                if (action === "load-more") {
                    void loadMore();
                    return;
                }

                const activityId = actionTarget?.dataset?.activityId;
                if (!action || !activityId) return;
                if (action === "rename") void handleRename(activityId);
                if (action === "delete") void handleDelete(activityId);
                if (action === "details") void handleDetails(activityId);
            });

            container.addEventListener("change", (event) => {
                const filterTarget = event.target?.closest?.("[data-activity-filter]");
                const filterKey = filterTarget?.dataset?.activityFilter;
                if (!filterKey || !(filterKey in filters)) {
                    return;
                }
                filters = { ...filters, [filterKey]: filterTarget.value ?? "" };
                void refresh();
            });
        });

        window.addEventListener("rider-tracker:activity-saved", () => {
            void refresh();
        });
    }

    async function refresh() {
        requestGeneration += 1;
        if (loading) {
            queuedRefresh = true;
            statusText = "正在更新活动列表...";
            render();
            return;
        }
        return loadPage({ reset: true, generation: requestGeneration });
    }

    async function loadMore() {
        if (loading || !page.hasMore) {
            return;
        }
        requestGeneration += 1;
        return loadPage({ reset: false, generation: requestGeneration });
    }

    async function loadPage({ reset, generation }) {
        if (!mountedContainers.length || loading || generation !== requestGeneration) {
            return;
        }

        loading = true;
        const requestFilters = { ...filters };
        const requestOffset = reset ? 0 : activities.length;
        if (reset) {
            statusText = activities.length ? "正在更新活动列表..." : "正在读取历史记录...";
        }
        render();

        try {
            const history = await fetchActivityHistory({
                limit,
                offset: requestOffset,
                ...requestFilters
            });
            if (generation !== requestGeneration) {
                return;
            }
            activities = reset
                ? history.activities
                : appendUniqueActivities(activities, history.activities);
            page = history.page ?? { total: activities.length, hasMore: false };
            onSummary(history.summary);
            statusText = activities.length ? "" : "暂无符合条件的活动记录。";
        } catch (error) {
            if (generation === requestGeneration) {
                statusText = `历史记录读取失败：${extractErrorMessage(error)}`;
            }
        } finally {
            loading = false;
            if (queuedRefresh) {
                queuedRefresh = false;
                void loadPage({ reset: true, generation: requestGeneration });
            } else if (generation === requestGeneration) {
                render();
            }
        }
    }

    function render() {
        mountedContainers.forEach((container) => {
            container.innerHTML = buildHistoryHtml({ activities, statusText, loading, page, filters });
        });
    }

    async function handleDetails(activityId) {
        try {
            statusText = "正在读取活动详情...";
            render();
            const activity = await getActivity(activityId);
            statusText = "";
            onStatus("活动详情已加载。");
            onOpenActivityDetail(activity);
            render();
        } catch (error) {
            statusText = `活动详情读取失败：${extractErrorMessage(error)}`;
            onStatus(statusText);
            render();
        }
    }

    async function handleRename(activityId) {
        const activity = activities.find((candidate) => candidate.id === activityId);
        const nextName = window.prompt("修改活动名称", activity?.name ?? "");
        if (nextName === null) return;

        const normalizedName = nextName.trim();
        if (!normalizedName) {
            onStatus("活动名称不能为空。");
            return;
        }

        try {
            await renameActivity(activityId, normalizedName);
            onStatus("活动名称已更新。");
            await refresh();
        } catch (error) {
            onStatus(`活动名称更新失败：${extractErrorMessage(error)}`);
        }
    }

    async function handleDelete(activityId) {
        const activity = activities.find((candidate) => candidate.id === activityId);
        const confirmed = window.confirm(`删除活动「${activity?.name ?? activityId}」？`);
        if (!confirmed) return;

        try {
            await deleteActivity(activityId);
            onStatus("活动已删除。");
            await refresh();
        } catch (error) {
            onStatus(`活动删除失败：${extractErrorMessage(error)}`);
        }
    }

    bindEvents();
    render();

    return { refresh, loadMore, render };
}

function buildHistoryHtml({ activities, statusText, loading, page, filters }) {
    const filtersHtml = buildHistoryFiltersHtml(filters, page, activities.length);
    if (!activities.length) {
        return `${filtersHtml}<div class="activity-history-empty">${escapeHtml(statusText || "暂无历史记录。")}</div>`;
    }

    const rows = activities.map((activity) => {
        const startedAt = formatActivityDate(activity.startedAt ?? activity.createdAt);
        const distance = Number.isFinite(activity.distanceKm) ? `${formatNumber(activity.distanceKm, 2)} km` : "-";
        const duration = Number.isFinite(activity.elapsedSeconds) ? formatDuration(activity.elapsedSeconds) : "-";
        const tss = Number.isFinite(activity.estimatedTss) ? formatNumber(activity.estimatedTss, 1) : "-";
        const power = Number.isFinite(activity.averagePower) ? `${Math.round(activity.averagePower)} W` : "-";
        const heartRate = Number.isFinite(activity.averageHr) ? `${Math.round(activity.averageHr)} bpm` : "-";

        return `
            <article class="activity-history-row">
                <div class="activity-history-main">
                    <div class="activity-history-title-row">
                        <strong>${escapeHtml(activity.name)}</strong>
                        <span>${escapeHtml(activity.sportType)}</span>
                    </div>
                    <div class="activity-history-meta">${escapeHtml(startedAt)} · ${escapeHtml(activity.source)}</div>
                    <div class="activity-history-stats">
                        <span>${escapeHtml(distance)}</span>
                        <span>${escapeHtml(duration)}</span>
                        <span>TSS ${escapeHtml(tss)}</span>
                        <span>${escapeHtml(power)}</span>
                        <span>${escapeHtml(heartRate)}</span>
                    </div>
                </div>
                <div class="activity-history-actions">
                    <button class="btn ghost compact-btn" data-activity-action="details" data-activity-id="${escapeHtml(activity.id)}">详情</button>
                    <button class="btn secondary compact-btn" data-activity-action="rename" data-activity-id="${escapeHtml(activity.id)}">改名</button>
                    <button class="btn ghost compact-btn danger-btn" data-activity-action="delete" data-activity-id="${escapeHtml(activity.id)}">删除</button>
                </div>
            </article>
        `;
    }).join("");

    const statusHtml = statusText ? `<div class="activity-history-empty">${escapeHtml(statusText)}</div>` : "";
    const loadMoreHtml = page?.hasMore
        ? `<div class="activity-history-more"><button class="btn secondary compact-btn" data-activity-action="load-more" type="button" ${loading ? "disabled" : ""}>${loading ? "正在加载..." : "加载更多"}</button></div>`
        : "";
    return `${filtersHtml}${statusHtml}<div class="activity-history-list">${rows}</div>${loadMoreHtml}`;
}

function buildHistoryFiltersHtml(filters, page, loadedCount) {
    const total = Number.isFinite(page?.total) ? page.total : loadedCount;
    const countText = total > loadedCount ? `已显示 ${loadedCount} / ${total} 条` : `共 ${total} 条`;
    return `
        <div class="activity-history-toolbar">
            <div class="activity-history-filters">
                <label>
                    <span>类型</span>
                    <select data-activity-filter="sportType">
                        ${buildFilterOption("", "全部", filters?.sportType)}
                        ${buildFilterOption("VirtualRide", "虚拟骑行", filters?.sportType)}
                        ${buildFilterOption("Ride", "户外骑行", filters?.sportType)}
                    </select>
                </label>
                <label>
                    <span>来源</span>
                    <select data-activity-filter="source">
                        ${buildFilterOption("", "全部", filters?.source)}
                        ${buildFilterOption("rider-tracker", "Rider Tracker", filters?.source)}
                        ${buildFilterOption("fit-import", "FIT 导入", filters?.source)}
                        ${buildFilterOption("beacon", "后台保存", filters?.source)}
                    </select>
                </label>
            </div>
            <span class="activity-history-count">${escapeHtml(countText)}</span>
        </div>
    `;
}

function buildFilterOption(value, label, selectedValue) {
    return `<option value="${escapeHtml(value)}"${value === selectedValue ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

function appendUniqueActivities(existing, incoming) {
    const seenIds = new Set(existing.map((activity) => activity.id));
    return [...existing, ...(incoming ?? []).filter((activity) => !seenIds.has(activity.id))];
}

function formatActivityDate(value) {
    if (!value) return "未知时间";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
    });
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
