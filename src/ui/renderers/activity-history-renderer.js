import { deleteActivity, getActivity, listActivities, renameActivity } from "../../adapters/storage/activity-history-client.js";
import { formatDuration, formatNumber } from "../../shared/format.js";
import { extractErrorMessage } from "../../shared/utils/common.js";

const DEFAULT_LIMIT = 12;

export function createActivityHistoryRenderer({
    containers = [],
    limit = DEFAULT_LIMIT,
    onStatus = () => {},
    onOpenActivityDetail = () => {}
} = {}) {
    const mountedContainers = containers.filter(Boolean);
    let activities = [];
    let loading = false;
    let statusText = "";
    let bound = false;

    function bindEvents() {
        if (bound) return;
        bound = true;

        mountedContainers.forEach((container) => {
            container.addEventListener("click", (event) => {
                const action = event.target?.dataset?.activityAction;
                const activityId = event.target?.dataset?.activityId;
                if (!action || !activityId) {
                    return;
                }
                if (action === "rename") {
                    void handleRename(activityId);
                }
                if (action === "delete") {
                    void handleDelete(activityId);
                }
                if (action === "details") {
                    void handleDetails(activityId);
                }
            });
        });

        window.addEventListener("rider-tracker:activity-saved", () => {
            void refresh();
        });
    }

    async function refresh() {
        if (!mountedContainers.length || loading) {
            return;
        }

        loading = true;
        statusText = "正在读取历史记录...";
        render();

        try {
            activities = await listActivities({ limit });
            statusText = activities.length ? "" : "暂无历史记录。";
        } catch (error) {
            statusText = `历史记录读取失败：${extractErrorMessage(error)}`;
        } finally {
            loading = false;
            render();
        }
    }

    function render() {
        mountedContainers.forEach((container) => {
            container.innerHTML = buildHistoryHtml({
                activities,
                statusText,
                loading
            });
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
        if (nextName === null) {
            return;
        }

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
        if (!confirmed) {
            return;
        }

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

    return {
        refresh,
        render
    };
}

function buildHistoryHtml({ activities, statusText, loading }) {
    if (loading) {
        return `<div class="activity-history-empty">正在读取历史记录...</div>`;
    }

    if (!activities.length) {
        return `<div class="activity-history-empty">${escapeHtml(statusText || "暂无历史记录。")}</div>`;
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
    return `${statusHtml}<div class="activity-history-list">${rows}</div>`;
}

function formatActivityDate(value) {
    if (!value) {
        return "未知时间";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return String(value);
    }
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
