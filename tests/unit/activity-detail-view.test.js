import { createActivityDetailView } from "../../src/ui/views/activity-detail-view.js";
import { assertEqual } from "../helpers/test-harness.js";
import { createFakeElement } from "../helpers/fake-dom.js";

export const suite = {
    name: "activity-detail-view",
    tests: [
        {
            name: "routes detail export actions to the selected activity session",
            run() {
                const previousDocument = globalThis.document;
                const activityDetailContent = createFakeElement();
                activityDetailContent.contains = () => true;
                globalThis.document = {
                    getElementById(id) {
                        return {
                            viewActivityDetail: createFakeElement(),
                            activityDetailContent,
                            activityDetailBackBtn: createFakeElement()
                        }[id] ?? null;
                    }
                };

                const exported = [];
                const activity = { id: "ride-1", rawSession: { id: "session-1" } };
                try {
                    const view = createActivityDetailView({
                        onSetUiMode() {},
                        onConnectStrava() {},
                        onUploadActivityFit() {},
                        onDownloadActivitySession(value) { exported.push(["json", value]); },
                        onDownloadActivityFit(value) { exported.push(["fit", value]); },
                        onUpdateExportMetadata() {},
                        getExportMetadata: () => ({})
                    });
                    view.setActivity(activity);

                    activityDetailContent.dispatch("click", {
                        target: createActionTarget("download-json")
                    });
                    activityDetailContent.dispatch("click", {
                        target: createActionTarget("download-fit")
                    });

                    assertEqual(exported[0][0], "json");
                    assertEqual(exported[0][1], activity);
                    assertEqual(exported[1][0], "fit");
                    assertEqual(exported[1][1], activity);
                } finally {
                    globalThis.document = previousDocument;
                }
            }
        }
    ]
};

function createActionTarget(action) {
    return {
        dataset: { activityPageAction: action },
        closest(selector) {
            return selector === "[data-activity-page-action]" ? this : null;
        }
    };
}
