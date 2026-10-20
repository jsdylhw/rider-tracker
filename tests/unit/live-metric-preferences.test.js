import { createLiveMetricPreferences } from "../../src/adapters/storage/live-metric-preferences.js";
import { createDashboardMetricCustomizer } from "../../src/ui/renderers/dashboard/dashboard-metric-customizer.js";
import { DEFAULT_METRIC_SELECTION } from "../../src/shared/live-metrics.js";
import { createFakeElement } from "../helpers/fake-dom.js";
import { assertEqual } from "../helpers/test-harness.js";
export const suite = { name: "live-metric-preferences", tests: [
    { name: "added and removed metrics survive a new dashboard instance", run() {
        let saved = null;
        const preferences = createLiveMetricPreferences({ getStorage: () => ({getItem: () => saved, setItem: (_, value) => { saved = value; }}) });
        const key = Object.keys(DEFAULT_METRIC_SELECTION).find(key => !DEFAULT_METRIC_SELECTION[key]);
        const elements = {addMetricBtn:createFakeElement(), metricAddSelect:createFakeElement({options:[], value:key}), selectedMetricsList:createFakeElement()};
        const first = createDashboardMetricCustomizer({elements, preferences});
        first.bindEvents(); elements.addMetricBtn.dispatch("click");
        assertEqual(createDashboardMetricCustomizer({elements:{}, preferences}).selection[key], true);
        elements.selectedMetricsList.dispatch("click", {target:{closest: () => ({dataset:{removeMetric:key}})}});
        assertEqual(createDashboardMetricCustomizer({elements:{}, preferences}).selection[key], false);
        const empty = Object.fromEntries(Object.keys(DEFAULT_METRIC_SELECTION).map(key => [key,false]));
        preferences.save(empty);
        assertEqual(Object.values(preferences.load()).some(Boolean), false);
    } },
    { name: "bad or unavailable preferences preserve defaults and do not throw", run() {
        for (const saved of ["broken", JSON.stringify({version:2,selection:{}}), JSON.stringify({version:1,selection:[]})]) {
            const preferences = createLiveMetricPreferences({getStorage: () => ({getItem: () => saved})});
            assertEqual(JSON.stringify(preferences.load()), JSON.stringify(DEFAULT_METRIC_SELECTION));
        }
        const unavailable = createLiveMetricPreferences({getStorage: () => {throw new Error("blocked");}});
        assertEqual(JSON.stringify(unavailable.load()), JSON.stringify(DEFAULT_METRIC_SELECTION));
        unavailable.save({});
        const key = Object.keys(DEFAULT_METRIC_SELECTION)[0];
        const preferences = createLiveMetricPreferences({getStorage: () => ({getItem: () => JSON.stringify({version:1,selection:{[key]:"invalid",removedMetric:true}})})});
        assertEqual(preferences.load()[key],DEFAULT_METRIC_SELECTION[key]);
        assertEqual(Object.hasOwn(preferences.load(),"removedMetric"),false);
    } }
] };
