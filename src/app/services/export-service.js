import { exportSessionAsFit } from "../../adapters/export/fit-exporter.js";
import { startStravaAuthorization, uploadFitToStravaServer } from "../../adapters/upload/strava-server-client.js";
import { downloadBinary, downloadJson } from "../../shared/format.js";
import { sanitizeExportMetadata } from "../store/initial-state.js";
import { extractErrorMessage } from "../../shared/utils/common.js";

const DEFAULT_REPOSITORY_URL = "https://github.com/jsdylhw/rider-tracker";

export function createExportService({ store }) {
    function updateExportMetadata(exportMetadata) {
        store.setState((state) => ({
            ...state,
            exportMetadata: {
                ...state.exportMetadata,
                ...sanitizeExportMetadata(exportMetadata)
            },
            statusText: "FIT 导出信息已更新。"
        }));
    }

    async function connectStrava() {
        const { exportMetadata } = store.getState();
        const authWindow = window.open("", "_blank");

        store.setState((state) => ({
            ...state,
            statusText: "正在打开 Strava 授权页面..."
        }));

        try {
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
                statusText: "请在新打开的 Strava 页面完成授权，完成后即可上传 FIT。"
            }));
        } catch (error) {
            if (authWindow) {
                authWindow.close();
            }
            console.error("Strava 授权启动失败", error);
            store.setState((state) => ({
                ...state,
                statusText: `Strava 授权启动失败：${extractErrorMessage(error)}`
            }));
        }
    }

    function downloadSession() {
        const { session } = store.getState();

        if (!session) {
            return;
        }

        const timestamp = session.createdAt.replaceAll(":", "-").split(".")[0];
        downloadJson(`ride-simulation-${timestamp}.json`, session);

        store.setState((state) => ({
            ...state,
            statusText: "已导出当前模拟数据 JSON。"
        }));
    }

    async function downloadFit() {
        const { session, exportMetadata } = store.getState();

        if (!session) {
            return;
        }

        store.setState((state) => ({
            ...state,
            statusText: "正在生成 FIT 文件..."
        }));

        try {
            const fitBytes = await exportSessionAsFit(session, exportMetadata, {
                markVirtualActivity: exportMetadata?.markVirtualActivity
            });
            const timestamp = session.createdAt.replaceAll(":", "-").split(".")[0];
            downloadBinary(`virtual-ride-${timestamp}.fit`, fitBytes, "application/vnd.ant.fit");

            store.setState((state) => ({
                ...state,
                statusText: "已导出 FIT 文件，包含虚拟骑行说明和仓库地址。"
            }));
        } catch (error) {
            console.error("FIT 导出失败", error);
            store.setState((state) => ({
                ...state,
                statusText: `FIT 导出失败：${extractErrorMessage(error)}`
            }));
        }
    }

    async function uploadFit() {
        const { session, exportMetadata } = store.getState();

        if (!session) {
            return;
        }

        if (!exportMetadata.stravaServerUrl) {
            store.setState((state) => ({
                ...state,
                statusText: "请先填写 Strava server 地址。"
            }));
            return;
        }

        store.setState((state) => ({
            ...state,
            statusText: "正在生成并上传 FIT 文件..."
        }));

        try {
            const fitBytes = await exportSessionAsFit(session, exportMetadata, {
                markVirtualActivity: exportMetadata?.markVirtualActivity
            });
            const timestamp = session.createdAt.replaceAll(":", "-").split(".")[0];
            const filename = `virtual-ride-${timestamp}.fit`;

            const upload = await uploadFitToStravaServer({
                serverUrl: exportMetadata.stravaServerUrl,
                userId: exportMetadata.stravaUserId,
                fitBytes,
                filename,
                activityName: exportMetadata.activityName,
                fitDescription: exportMetadata.fitDescription,
                repositoryUrl: exportMetadata.repositoryUrl,
                generatedMessage: buildGeneratedMessage(exportMetadata.repositoryUrl),
                trainer: true,
                commute: false,
                sportType: "VirtualRide",
                externalId: buildExternalId(session, timestamp)
            });

            store.setState((state) => ({
                ...state,
                statusText: `Strava 上传完成，活动 ID：${upload.activity_id}。`
            }));
        } catch (error) {
            console.error("FIT 上传失败", error);
            store.setState((state) => ({
                ...state,
                statusText: `FIT 上传失败：${extractErrorMessage(error)}`
            }));
        }
    }

    return {
        updateExportMetadata,
        connectStrava,
        downloadSession,
        downloadFit,
        uploadFit
    };
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
