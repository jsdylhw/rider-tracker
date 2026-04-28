import {
    DEFAULT_METRIC_SELECTION,
    DEFAULT_PIP_METRIC_SELECTION,
    buildMetricCardsHtml,
    getEnabledMetricKeys,
    normalizeMetricSelection
} from "../../src/shared/live-metrics.js";
import { assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "live-metrics",
    tests: [
        {
            name: "normalizeMetricSelection applies known overrides and ignores unknown keys",
            run() {
                const selection = normalizeMetricSelection({
                    currentPower: false,
                    routeProgress: true,
                    unknownMetric: true
                });

                assertEqual(selection.currentPower, false);
                assertEqual(selection.routeProgress, true);
                assertEqual(Object.hasOwn(selection, "unknownMetric"), false);
                assertEqual(DEFAULT_METRIC_SELECTION.currentPower, true);
            }
        },
        {
            name: "PiP 默认指标启用距离、剩余距离、坡度和目标控制值",
            run() {
                const keys = getEnabledMetricKeys(DEFAULT_PIP_METRIC_SELECTION);

                assertEqual(keys.includes("distanceKm"), true);
                assertEqual(keys.includes("remainingKm"), true);
                assertEqual(keys.includes("currentGrade"), true);
                assertEqual(keys.includes("lookaheadGrade"), true);
                assertEqual(keys.includes("targetControl"), true);
                assertEqual(keys.includes("avg3sPower"), false);
            }
        },
        {
            name: "buildMetricCardsHtml renders selected metrics and hidden session placeholders",
            run() {
                const html = buildMetricCardsHtml({
                    metricsData: {
                        currentPower: { label: "实时功率", value: 260, unit: "W", color: "power-color" }
                    },
                    metricKeys: ["currentPower"],
                    hasSession: false
                });

                assertEqual(html.includes("实时功率"), true);
                assertEqual(html.includes("--"), true);
                assertEqual(html.includes("260"), false);
            }
        },
        {
            name: "buildMetricCardsHtml renders empty message when no metrics match",
            run() {
                const html = buildMetricCardsHtml({
                    metricsData: {},
                    metricKeys: ["missingMetric"],
                    emptyMessage: "没有可显示指标"
                });

                assertEqual(html.includes("没有可显示指标"), true);
            }
        }
    ]
};
