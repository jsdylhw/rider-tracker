import { exportSessionAsFit } from "../../adapters/export/fit-exporter.js";
import { downloadBinary, downloadJson } from "../../shared/format.js";
import { sanitizeExportMetadata } from "../store/initial-state.js";
import { extractErrorMessage } from "../../shared/utils/common.js";

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
            const fitBytes = await exportSessionAsFit(session, exportMetadata);
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

    return {
        updateExportMetadata,
        downloadSession,
        downloadFit
    };
}