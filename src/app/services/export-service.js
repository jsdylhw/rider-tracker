import { exportSessionAsFit } from "../../adapters/export/fit-exporter.js";
import {
    getStravaConnection,
    getStravaServerConfig,
    startStravaAuthorization,
    uploadSavedActivityFitToStravaServer,
} from "../../adapters/upload/strava-server-client.js";
import {
    importActivityFitFile,
    saveActivityFitFile,
    saveRiderSessionActivity
} from "../../adapters/storage/activity-history-client.js";
import { downloadBinary, downloadJson } from "../../shared/format.js";
import { sanitizeExportMetadata } from "../store/initial-state.js";
import { extractErrorMessage } from "../../shared/utils/common.js";

const DEFAULT_REPOSITORY_URL = "https://github.com/jsdylhw/rider-tracker";
const STRAVA_CONNECT_TIMEOUT_MS = 90 * 1000;
const STRAVA_CONNECT_POLL_MS = 1500;

export function createExportService({ store }) {
    function updateExportMetadata(exportMetadata) {
        store.setState((state) => ({
            ...state,
            exportMetadata: sanitizeExportMetadata({
                ...state.exportMetadata,
                ...exportMetadata
            }),
            statusText: "FIT export settings updated."
        }));
    }

    async function connectStrava() {
        const { exportMetadata } = store.getState();
        const authWindow = window.open("", "_blank");
        writePopupMessage(authWindow, {
            title: "Checking Strava",
            message: "Rider Tracker is checking the local Strava server configuration."
        });

        store.setState((state) => ({
            ...state,
            statusText: "正在检查 Strava 本地服务配置..."
        }));

        try {
            const config = await getStravaServerConfig({
                serverUrl: exportMetadata.stravaServerUrl
            });

            if (!config?.configured) {
                const loginUrl = buildStravaLoginUrl({
                    serverUrl: exportMetadata.stravaServerUrl,
                    loginPath: config?.loginUrl,
                    userId: exportMetadata.stravaUserId
                });
                if (authWindow) {
                    authWindow.location.href = loginUrl;
                } else {
                    window.location.href = loginUrl;
                }
                const message = "请在打开的 Strava 登录配置页面保存 Client ID / Secret，并继续授权。";
                store.setState((state) => ({
                    ...state,
                    statusText: message
                }));
                return;
            }

            const { authUrl } = await startStravaAuthorization({
                serverUrl: exportMetadata.stravaServerUrl,
                userId: exportMetadata.stravaUserId
            });

            if (authWindow) {
                authWindow.location.href = authUrl;
            } else {
                window.location.href = authUrl;
            }

            store.setState((state) => ({
                ...state,
                statusText: "请在打开的 Strava 页面完成授权..."
            }));

            const connection = await waitForStravaConnection({
                serverUrl: exportMetadata.stravaServerUrl,
                userId: exportMetadata.stravaUserId
            });

            const athleteName = connection?.athlete?.username || connection?.athlete?.firstname || connection?.userId || "default";
            store.setState((state) => ({
                ...state,
                statusText: `Strava 已连接：${athleteName}。现在可以上传 FIT。`
            }));
        } catch (error) {
            if (authWindow && !authWindow.closed) {
                writePopupMessage(authWindow, {
                    title: "Strava connection failed",
                    message: buildStravaConnectErrorMessage(error)
                });
            }
            console.error("Strava authorization failed", error);
            const message = buildStravaConnectErrorMessage(error);
            notifyUser(message);
            store.setState((state) => ({
                ...state,
                statusText: message
            }));
        }
    }

    function downloadSession() {
        const { session } = store.getState();
        return downloadSessionJson(session);
    }

    async function downloadFit() {
        const { session, exportMetadata } = store.getState();
        return downloadSessionFit(session, exportMetadata);
    }

    function downloadActivitySession(activity) {
        return downloadSessionJson(activity?.rawSession ?? null);
    }

    async function downloadActivityFit(activity) {
        const session = activity?.rawSession ?? null;
        const { exportMetadata } = store.getState();
        return downloadSessionFit(session, {
            ...exportMetadata,
            ...(session?.exportMetadata ?? {})
        });
    }

    function downloadSessionJson(session) {
        if (!session) {
            setExportStatus("当前活动缺少可导出的原始会话数据。");
            return false;
        }

        const timestamp = formatSessionTimestamp(session);
        downloadJson(`ride-simulation-${timestamp}.json`, session);
        setExportStatus("当前骑行会话已导出为 JSON。");
        return true;
    }

    async function downloadSessionFit(session, exportMetadata) {
        if (!session) {
            setExportStatus("当前活动缺少可导出的原始会话数据。");
            return false;
        }

        store.setState((state) => ({ ...state, statusText: "正在生成 FIT 文件..." }));
        try {
            const fitBytes = await exportSessionAsFit(session, exportMetadata, {
                markVirtualActivity: exportMetadata?.markVirtualActivity
            });
            const filename = `virtual-ride-${formatSessionTimestamp(session)}.fit`;
            await saveFitFileForSession({ session, fitBytes, filename });
            downloadBinary(filename, fitBytes, "application/vnd.ant.fit");
            setExportStatus("FIT 文件已导出。");
            return true;
        } catch (error) {
            console.error("FIT export failed", error);
            setExportStatus(`FIT 导出失败：${extractErrorMessage(error)}`);
            return false;
        }
    }

    function setExportStatus(statusText) {
        store.setState((state) => ({ ...state, statusText }));
    }

    async function uploadFit() {
        const { session, exportMetadata } = store.getState();
        if (!session) return;
        await uploadActivityFitFromDatabase({ activity: null, session, exportMetadata });
    }

    async function importFit(file) {
        if (!file) {
            return;
        }

        store.setState((state) => ({
            ...state,
            statusText: "正在解析本地 FIT 文件..."
        }));

        try {
            const fitBytes = new Uint8Array(await file.arrayBuffer());
            const savedActivity = await importActivityFitFile({
                fitBytes,
                filename: file.name,
                name: file.name
            });
            if (!savedActivity?.rawSession) {
                throw new Error("FIT 导入未返回可展示的活动详情。");
            }
            const session = savedActivity.rawSession;
            notifyActivitySaved(savedActivity);

            store.setState((state) => ({
                ...state,
                session,
                selectedActivity: savedActivity,
                uiMode: "activity-detail",
                hasPersistedSession: true,
                statusText: `已导入 FIT 文件：${file.name}。`
            }));
        } catch (error) {
            console.error("FIT import failed", error);
            store.setState((state) => ({
                ...state,
                statusText: `FIT 导入失败：${extractErrorMessage(error)}`
            }));
        }
    }

    async function uploadActivityFit(uploadOptions = {}) {
        const { selectedActivity, session, exportMetadata } = store.getState();
        const activitySession = selectedActivity?.rawSession ?? session;

        if (!activitySession && !selectedActivity?.id) {
            store.setState((state) => ({
                ...state,
                statusText: "没有可上传的活动数据。"
            }));
            return;
        }

        if (selectedActivity?.id && activitySession) {
            activitySession.activityId = selectedActivity.id;
        }

        await uploadActivityFitFromDatabase({
            activity: selectedActivity,
            session: activitySession,
            exportMetadata: {
                ...exportMetadata,
                ...(activitySession?.exportMetadata ?? {}),
                activityName: uploadOptions.activityName ?? selectedActivity?.name ?? exportMetadata.activityName ?? activitySession?.exportMetadata?.activityName,
                fitDescription: uploadOptions.fitDescription ?? exportMetadata.fitDescription,
                // This is intentionally per-upload. Do not reuse the archive
                // classification or a previous upload's choice.
                markVirtualActivity: uploadOptions.markVirtualActivity === true
            }
        });
    }

    async function archiveFitForSession(sessionArg = null, metadataOverride = null) {
        const { session, exportMetadata } = store.getState();
        const targetSession = sessionArg ?? session;

        if (!targetSession) {
            return null;
        }

        try {
            const metadata = {
                ...exportMetadata,
                ...(targetSession.exportMetadata ?? {}),
                ...(metadataOverride ?? {})
            };
            const markVirtualActivity = metadata.markVirtualActivity === true;
            const fitBytes = await exportSessionAsFit(targetSession, metadata, {
                markVirtualActivity
            });
            const timestamp = resolveSessionTimestamp(targetSession);
            const filename = `${markVirtualActivity ? "virtual-ride" : "ride"}-${timestamp}.fit`;
            const activity = await saveFitFileForSession({
                session: targetSession,
                fitBytes,
                filename
            });
            updateSelectedActivityFit(activity, targetSession);
            return activity;
        } catch (error) {
            console.error("FIT archive failed", error);
            store.setState((state) => ({
                ...state,
                statusText: `FIT 归档失败：${extractErrorMessage(error)}`
            }));
            return null;
        }
    }

    async function archiveSessionAsFitActivity(sessionArg = null, options = {}) {
        const { session, exportMetadata } = store.getState();
        const targetSession = sessionArg ?? session;

        if (!targetSession) {
            return null;
        }

        try {
            const metadata = {
                ...exportMetadata,
                ...(targetSession.exportMetadata ?? {}),
                ...(options.exportMetadata ?? {})
            };
            const fitBytes = await exportSessionAsFit(targetSession, metadata, {
                // Completed rides are stored as a neutral FIT. The upload modal
                // creates the virtual variant only when the user selects it.
                markVirtualActivity: options.markVirtualActivity === true
            });
            const timestamp = resolveSessionTimestamp(targetSession);
            const filename = options.filename ?? `ride-${timestamp}.fit`;
            const compactSession = buildCompactFitSession(targetSession, {
                markVirtualActivity: false
            });
            const savedActivity = await importActivityFitFile({
                session: compactSession,
                fitBytes,
                filename,
                name: options.name ?? metadata.activityName ?? targetSession.exportMetadata?.activityName,
                sportType: options.sportType ?? "Ride"
            });

            if (savedActivity?.id) {
                targetSession.activityId = savedActivity.id;
            }
            notifyActivitySaved(savedActivity);
            updateSelectedActivityFit(savedActivity, targetSession);
            return savedActivity;
        } catch (error) {
            console.error("FIT activity archive failed", error);
            store.setState((state) => ({
                ...state,
                statusText: `FIT 活动保存失败：${extractErrorMessage(error)}`
            }));
            return null;
        }
    }

    async function uploadActivityFitFromDatabase({ activity, session, exportMetadata }) {
        if (!exportMetadata.stravaServerUrl) {
            store.setState((state) => ({
                ...state,
                statusText: "Missing Strava server URL."
            }));
            return;
        }

        store.setState((state) => ({
            ...state,
            statusText: "Checking Strava connection..."
        }));

        try {
            const connection = await getStravaConnection({
                serverUrl: exportMetadata.stravaServerUrl,
                userId: exportMetadata.stravaUserId
            });

            if (!connection?.configured) {
                throw new Error("Strava credentials are not configured on the local server.");
            }
            if (!connection?.connected) {
                store.setState((state) => ({
                    ...state,
                    statusText: "Click Connect Strava first, then upload FIT."
                }));
                return;
            }

            let activityForUpload = activity;
            if (!activityForUpload?.fitFilePath) {
                if (!session) {
                    throw new Error("Activity does not have an archived FIT file.");
                }
                activityForUpload = await archiveFitForSession(session);
            }
            if (!activityForUpload?.id || !activityForUpload?.fitFilePath) {
                throw new Error("Activity FIT archive is missing.");
            }

            store.setState((state) => ({
                ...state,
                statusText: "Uploading archived FIT file..."
            }));

            const uploadAsVirtual = exportMetadata?.markVirtualActivity === true;
            const hasGpsTrack = session ? sessionHasGpsTrack(session) : activityForUpload.hasGpsTrack === true;
            const upload = await uploadSavedActivityFitToStravaServer({
                serverUrl: exportMetadata.stravaServerUrl,
                userId: exportMetadata.stravaUserId,
                activityId: activityForUpload.id,
                activityName: exportMetadata.activityName ?? activityForUpload.name,
                fitDescription: exportMetadata.fitDescription,
                repositoryUrl: exportMetadata.repositoryUrl,
                generatedMessage: buildGeneratedMessage(exportMetadata.repositoryUrl),
                trainer: uploadAsVirtual && !hasGpsTrack,
                commute: false,
                sportType: uploadAsVirtual ? "VirtualRide" : "Ride"
            });

            updateSelectedActivityFit(activityForUpload, session ?? activityForUpload.rawSession, activity);
            store.setState((state) => ({
                ...state,
                statusText: `Strava upload complete. Activity ID: ${upload.activity_id}.`
            }));
        } catch (error) {
            console.error("FIT upload failed", error);
            store.setState((state) => ({
                ...state,
                statusText: `FIT upload failed: ${extractErrorMessage(error)}`
            }));
        }
    }

    function updateSelectedActivityFit(activity, session, fallbackActivity = null) {
        if (!activity?.id && !fallbackActivity?.id) {
            return;
        }

        const nextActivity = {
            ...(fallbackActivity ?? {}),
            ...(activity ?? {}),
            rawSession: session
        };

        store.setState((state) => ({
            ...state,
            selectedActivity: state.selectedActivity?.id === nextActivity.id
                ? {
                    ...state.selectedActivity,
                    ...nextActivity
                }
                : state.selectedActivity
        }));
    }

    return {
        updateExportMetadata,
        connectStrava,
        downloadSession,
        downloadFit,
        downloadActivitySession,
        downloadActivityFit,
        importFit,
        uploadFit,
        uploadActivityFit,
        archiveFitForSession,
        archiveSessionAsFitActivity
    };
}

function formatSessionTimestamp(session) {
    return String(session?.createdAt ?? new Date().toISOString()).replaceAll(":", "-").split(".")[0];
}

async function saveFitFileForSession({ session, fitBytes, filename }) {
    try {
        const activity = session.activityId
            ? { id: session.activityId }
            : await saveRiderSessionActivity(session);
        if (activity?.id) {
            session.activityId = activity.id;
            return await saveActivityFitFile(activity.id, {
                fitBytes,
                filename
            });
        }
    } catch (error) {
        console.warn("[ExportService] 保存本地 FIT 文件失败:", error);
    }
    return null;
}

function notifyActivitySaved(activity) {
    if (!activity?.id) {
        return;
    }
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent !== "undefined") {
        window.dispatchEvent(new CustomEvent("rider-tracker:activity-saved", {
            detail: { activity }
        }));
    }
}

function buildCompactFitSession(session, exportMetadataOverride = null) {
    if (!session) {
        return null;
    }

    return {
        id: session.id,
        activityId: session.activityId,
        source: session.source ?? "rider-tracker",
        createdAt: session.createdAt,
        startedAt: session.startedAt,
        finishedAt: session.finishedAt,
        settings: session.settings,
        summary: session.summary,
        exportMetadata: {
            ...(session.exportMetadata ?? {}),
            ...(exportMetadataOverride ?? {})
        },
        hasGpsTrack: sessionHasGpsTrack(session),
        route: buildCompactRouteMap(session.route),
        records: []
    };
}

function buildCompactRouteMap(route) {
    const sourcePoints = route?.mapGeometry?.length >= 2 ? route.mapGeometry : route?.points;
    const points = (sourcePoints ?? [])
        .map((point) => {
            const latitude = point?.latitude ?? point?.lat;
            const longitude = point?.longitude ?? point?.lng;
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
                return null;
            }
            return {
                latitude,
                longitude,
                distanceMeters: Number.isFinite(point?.distanceMeters) ? point.distanceMeters : null
            };
        })
        .filter(Boolean);

    if (points.length < 2) {
        return null;
    }

    return {
        source: route?.source ?? "gpx",
        name: route?.name ?? "路线",
        totalDistanceMeters: route?.totalDistanceMeters ?? points.at(-1)?.distanceMeters ?? 0,
        savedRouteId: route?.savedRouteId ?? null,
        savedRouteResumeDistanceMeters: route?.savedRouteResumeDistanceMeters ?? 0,
        continuation: route?.continuation ?? null,
        mapGeometry: downsampleRouteGeometry(points)
    };
}

function downsampleRouteGeometry(points, maxPoints = 1600) {
    if (points.length <= maxPoints) {
        return points;
    }

    const lastIndex = points.length - 1;
    const step = lastIndex / (maxPoints - 1);
    return Array.from({ length: maxPoints }, (_, index) => {
        const sourceIndex = index === maxPoints - 1 ? lastIndex : Math.round(index * step);
        return points[sourceIndex];
    });
}

function resolveSessionTimestamp(session) {
    return String(session?.createdAt ?? session?.finishedAt ?? new Date().toISOString())
        .replaceAll(":", "-")
        .split(".")[0];
}

function buildMissingStravaConfigMessage(config) {
    const callback = config?.redirectUri || "http://localhost:8787/api/strava/auth/callback";
    return [
        "Strava 尚未配置。请在项目根目录创建 .env，填写 STRAVA_CLIENT_ID 和 STRAVA_CLIENT_SECRET，然后重启 npm.cmd start。",
        `Strava App 的 callback URL 设置为：${callback}`
    ].join(" ");
}

function buildStravaLoginUrl({ serverUrl, loginPath, userId }) {
    const baseUrl = String(serverUrl || window.location.origin).replace(/\/+$/, "");
    const url = new URL(loginPath || "/strava/login", `${baseUrl}/`);
    if (userId) url.searchParams.set("userId", userId);
    return url.toString();
}

function buildStravaConnectErrorMessage(error) {
    const message = extractErrorMessage(error);
    if (message.includes("404") || message.includes("Cannot GET /api/strava/config")) {
        return "当前运行的 server 不是最新版本。请先停止旧进程，然后重新运行 npm.cmd start。";
    }
    return `Strava 连接失败：${message}`;
}

function notifyUser(message) {
    if (typeof window.alert === "function") {
        window.alert(message);
    }
}

function writePopupMessage(authWindow, { title, message }) {
    if (!authWindow || authWindow.closed) return;

    try {
        authWindow.document.title = title;
        authWindow.document.body.innerHTML = `
            <main style="font-family: system-ui, sans-serif; max-width: 640px; margin: 48px auto; line-height: 1.6; color: #222f3e;">
                <h1 style="font-size: 24px; margin: 0 0 12px;">${escapeHtml(title)}</h1>
                <p style="white-space: pre-wrap; color: #475569;">${escapeHtml(message)}</p>
            </main>
        `;
    } catch {
        // Cross-origin after navigation; nothing to update.
    }
}

function escapeHtml(value) {
    return String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function waitForStravaConnection({ serverUrl, userId }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let pollTimer = null;
        const startedAt = Date.now();

        const cleanup = () => {
            settled = true;
            window.removeEventListener("message", handleMessage);
            if (pollTimer) window.clearTimeout(pollTimer);
        };

        const finish = (connection) => {
            if (settled) return;
            cleanup();
            resolve(connection);
        };

        const fail = (error) => {
            if (settled) return;
            cleanup();
            reject(error);
        };

        const poll = async () => {
            try {
                const connection = await getStravaConnection({ serverUrl, userId });
                if (connection?.connected) {
                    finish(connection);
                    return;
                }

                if (Date.now() - startedAt >= STRAVA_CONNECT_TIMEOUT_MS) {
                    fail(new Error("Timed out waiting for Strava authorization."));
                    return;
                }
            } catch (error) {
                fail(error);
                return;
            }

            pollTimer = window.setTimeout(poll, STRAVA_CONNECT_POLL_MS);
        };

        const handleMessage = async (event) => {
            if (event.origin !== window.location.origin) return;
            if (event.data?.type !== "rider-tracker:strava-connected") return;

            try {
                const connection = await getStravaConnection({ serverUrl, userId });
                finish(connection);
            } catch (error) {
                fail(error);
            }
        };

        window.addEventListener("message", handleMessage);
        poll();
    });
}

function buildGeneratedMessage(repositoryUrl) {
    const safeRepositoryUrl = String(repositoryUrl || "").trim() || DEFAULT_REPOSITORY_URL;
    return `This FIT activity file was generated by the open-source Rider Tracker project. Source: ${safeRepositoryUrl}`;
}

function buildExternalId(session, timestamp) {
    const routeName = session?.route?.name ? String(session.route.name).slice(0, 24) : "route";
    const safeRouteName = routeName.replaceAll(/\s+/g, "-").replaceAll(/[^a-zA-Z0-9-_]/g, "");
    return `rider-tracker-${safeRouteName}-${timestamp}`;
}

function sessionHasGpsTrack(session) {
    return (session?.records ?? []).some((record) => (
        Number.isFinite(record?.positionLat)
        && Number.isFinite(record?.positionLong)
    ));
}
