import { createExportView } from "../../src/ui/views/export-view.js";
import { assert, assertEqual } from "../helpers/test-harness.js";

function createButton() {
    const listeners = new Map();
    return {
        disabled: true,
        addEventListener(type, handler) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(handler);
        },
        dispatch(type) {
            for (const handler of listeners.get(type) ?? []) {
                handler();
            }
        }
    };
}

function createTemplateBackedDocument() {
    const buttons = {
        downloadSessionBtn: createButton(),
        downloadFitBtn: createButton(),
        connectStravaBtn: createButton(),
        uploadFitBtn: createButton()
    };
    const fitExportForm = {};
    const mountedElements = {
        "#fitExportForm": fitExportForm,
        "#downloadSessionBtn": buttons.downloadSessionBtn,
        "#downloadFitBtn": buttons.downloadFitBtn,
        "#connectStravaBtn": buttons.connectStravaBtn,
        "#uploadFitBtn": buttons.uploadFitBtn
    };
    const exportCardContainer = {
        childElementCount: 0,
        appendChild(node) {
            if (node?.type === "export-card") {
                this.childElementCount += 1;
            }
        },
        querySelector(selector) {
            return this.childElementCount > 0 ? (mountedElements[selector] ?? null) : null;
        }
    };
    const exportCardTemplate = {
        content: {
            cloneNode() {
                return { type: "export-card" };
            }
        }
    };
    const liveExportSlot = {};

    const document = {
        getElementById(id) {
            return {
                exportCardContainer,
                "export-card-template": exportCardTemplate,
                liveExportSlot
            }[id] ?? null;
        }
    };

    return {
        document,
        exportCardContainer,
        buttons
    };
}

export const suite = {
    name: "export-view",
    tests: [
        {
            name: "mounts template controls before binding export button handlers",
            run() {
                const previousDocument = globalThis.document;
                const fake = createTemplateBackedDocument();
                let downloadSessionClicks = 0;
                let downloadFitClicks = 0;
                let connectStravaClicks = 0;
                let uploadFitClicks = 0;

                globalThis.document = fake.document;
                try {
                    const view = createExportView({
                        onDownloadSession: () => { downloadSessionClicks += 1; },
                        onDownloadFit: () => { downloadFitClicks += 1; },
                        onConnectStrava: () => { connectStravaClicks += 1; },
                        onUploadFit: () => { uploadFitClicks += 1; }
                    });

                    assertEqual(fake.exportCardContainer.childElementCount, 1);
                    assert(view.elements.downloadSessionBtn, "JSON 导出按钮应来自已挂载的模板");
                    assert(view.elements.downloadFitBtn, "FIT 导出按钮应来自已挂载的模板");
                    assert(view.elements.connectStravaBtn, "Strava 连接按钮应来自已挂载的模板");
                    assert(view.elements.uploadFitBtn, "FIT 上传按钮应来自已挂载的模板");

                    fake.buttons.downloadSessionBtn.dispatch("click");
                    fake.buttons.downloadFitBtn.dispatch("click");
                    fake.buttons.connectStravaBtn.dispatch("click");
                    fake.buttons.uploadFitBtn.dispatch("click");

                    assertEqual(downloadSessionClicks, 1);
                    assertEqual(downloadFitClicks, 1);
                    assertEqual(connectStravaClicks, 1);
                    assertEqual(uploadFitClicks, 1);
                } finally {
                    globalThis.document = previousDocument;
                }
            }
        }
    ]
};
