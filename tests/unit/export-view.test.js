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

function createFileInput(file) {
    const listeners = new Map();
    return {
        files: file ? [file] : [],
        value: "selected.fit",
        clickCount: 0,
        addEventListener(type, handler) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(handler);
        },
        click() {
            this.clickCount += 1;
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
        importFitBtn: createButton(),
        connectStravaBtn: createButton(),
        uploadFitBtn: createButton()
    };
    const importFile = { name: "local.fit" };
    const importFitInput = createFileInput(importFile);
    const homeImportFile = { name: "home-local.fit" };
    const homeImportFitInput = createFileInput(homeImportFile);
    const homeImportFitBtn = createButton();
    const fitExportForm = {};
    const mountedElements = {
        "#fitExportForm": fitExportForm,
        "#downloadSessionBtn": buttons.downloadSessionBtn,
        "#downloadFitBtn": buttons.downloadFitBtn,
        "#importFitInput": importFitInput,
        "#importFitBtn": buttons.importFitBtn,
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
                liveExportSlot,
                homeImportFitInput,
                homeImportFitBtn
            }[id] ?? null;
        }
    };

    return {
        document,
        exportCardContainer,
        importFile,
        importFitInput,
        homeImportFile,
        homeImportFitInput,
        homeImportFitBtn,
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
                const importedFiles = [];
                let connectStravaClicks = 0;
                let uploadFitClicks = 0;

                globalThis.document = fake.document;
                try {
                    const view = createExportView({
                        onDownloadSession: () => { downloadSessionClicks += 1; },
                        onDownloadFit: () => { downloadFitClicks += 1; },
                        onImportFit: (file) => { importedFiles.push(file); },
                        onConnectStrava: () => { connectStravaClicks += 1; },
                        onUploadFit: () => { uploadFitClicks += 1; }
                    });

                    assertEqual(fake.exportCardContainer.childElementCount, 1);
                    assert(view.elements.downloadSessionBtn, "JSON 导出按钮应来自已挂载的模板");
                    assert(view.elements.downloadFitBtn, "FIT 导出按钮应来自已挂载的模板");
                    assert(view.elements.importFitBtn, "FIT 导入按钮应来自已挂载的模板");
                    assert(view.elements.importFitInput, "FIT 导入 input 应来自已挂载的模板");
                    assert(view.elements.homeImportFitBtn, "首页 FIT 导入按钮应可绑定");
                    assert(view.elements.homeImportFitInput, "首页 FIT 导入 input 应可绑定");
                    assert(view.elements.connectStravaBtn, "Strava 连接按钮应来自已挂载的模板");
                    assert(view.elements.uploadFitBtn, "FIT 上传按钮应来自已挂载的模板");

                    fake.buttons.downloadSessionBtn.dispatch("click");
                    fake.buttons.downloadFitBtn.dispatch("click");
                    fake.buttons.importFitBtn.dispatch("click");
                    fake.importFitInput.dispatch("change");
                    fake.homeImportFitBtn.dispatch("click");
                    fake.homeImportFitInput.dispatch("change");
                    fake.buttons.connectStravaBtn.dispatch("click");
                    fake.buttons.uploadFitBtn.dispatch("click");

                    assertEqual(downloadSessionClicks, 1);
                    assertEqual(downloadFitClicks, 1);
                    assertEqual(fake.importFitInput.clickCount, 1);
                    assertEqual(fake.homeImportFitInput.clickCount, 1);
                    assertEqual(importedFiles[0], fake.importFile);
                    assertEqual(importedFiles[1], fake.homeImportFile);
                    assertEqual(fake.importFitInput.value, "");
                    assertEqual(fake.homeImportFitInput.value, "");
                    assertEqual(connectStravaClicks, 1);
                    assertEqual(uploadFitClicks, 1);
                } finally {
                    globalThis.document = previousDocument;
                }
            }
        }
    ]
};
