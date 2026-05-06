import { buildMetricCardsHtml } from "../../shared/live-metrics.js";
import { buildPipChartsHtml } from "./pip-charts.js";
import { buildPipContentHtml } from "./pip-template.js";

export function createPipController({ button, template, getData }) {
    let pipWindow = null;

    function render() {
        if (!pipWindow) {
            return;
        }

        const container = pipWindow.document.getElementById("pip-content");

        if (!container) {
            return;
        }

        if (container.dataset.mounted !== "true") {
            container.innerHTML = buildPipContentHtml();
            container.dataset.mounted = "true";
        }

        sync();
    }

    function sync() {
        if (!pipWindow) {
            return;
        }

        const data = getData();
        const controlStatusEl = pipWindow.document.getElementById("pipControlStatus");
        const metricsListEl = pipWindow.document.getElementById("pipMetricsList");
        const chartsListEl = pipWindow.document.getElementById("pipChartsList");

        if (metricsListEl) {
            metricsListEl.className = `pip-training-grid ${data.pipLayout ?? "grid"}`;
            metricsListEl.innerHTML = buildMetricCardsHtml({
                metricsData: data.metricsData,
                metricKeys: data.enabledMetricKeys,
                itemClass: "pip-metric",
                labelClass: "pip-metric-label",
                valueClass: "pip-metric-val",
                unitClass: "pip-metric-unit",
                emptyMessage: "请在 PiP 显示中选择指标。"
            });
        }
        if (chartsListEl) {
            chartsListEl.innerHTML = buildPipChartsHtml({
                chartKeys: data.enabledChartKeys,
                route: data.route,
                currentRecord: data.currentRecord,
                records: data.records,
                ftp: data.ftp
            });
        }
        if (controlStatusEl) controlStatusEl.innerText = data.controlStatus;
    }

    function refreshButtonState() {
        if (!button) {
            return;
        }

        button.innerText = pipWindow ? "关闭悬浮窗" : "开启悬浮窗";

        if (pipWindow) {
            button.classList.add("danger");
            button.classList.remove("secondary");
            button.style.backgroundColor = "var(--danger)";
        } else {
            button.classList.add("secondary");
            button.classList.remove("danger");
            button.style.backgroundColor = "var(--secondary)";
        }
    }

    async function open() {
        pipWindow = await window.documentPictureInPicture.requestWindow({
            width: 320,
            height: 240,
            disallowReturnToOpener: true
        });

        const pipContent = template.content.cloneNode(true);
        pipWindow.document.body.append(pipContent);

        [...document.styleSheets].forEach((styleSheet) => {
            try {
                const cssRules = [...styleSheet.cssRules].map((rule) => rule.cssText).join("");
                const style = document.createElement("style");
                style.textContent = cssRules;
                pipWindow.document.head.appendChild(style);
            } catch (error) {
                if (!styleSheet.href) {
                    return;
                }

                const link = document.createElement("link");
                link.rel = "stylesheet";
                link.type = styleSheet.type;
                link.media = styleSheet.media;
                link.href = styleSheet.href;
                pipWindow.document.head.appendChild(link);
            }
        });

        render();
        refreshButtonState();

        pipWindow.addEventListener("pagehide", () => {
            pipWindow = null;
            refreshButtonState();
        });
    }

    async function toggle() {
        if (!("documentPictureInPicture" in window)) {
            return;
        }

        if (pipWindow) {
            pipWindow.close();
            return;
        }

        try {
            await open();
        } catch (error) {
            console.error("开启悬浮窗失败", error);
            alert("开启悬浮窗失败，请确保使用最新版 Chrome 或 Edge 浏览器。");
        }
    }

    if (button) {
        button.addEventListener("click", toggle);
    }

    refreshButtonState();

    return {
        render,
        sync,
        isSupported: "documentPictureInPicture" in window
    };
}
