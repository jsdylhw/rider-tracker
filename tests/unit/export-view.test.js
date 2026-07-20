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
        },
        cloneNode() {
            return createButton();
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

function createImportViewDocument() {
    const homeImportFile = { name: "home-local.fit" };
    const homeImportFitInput = createFileInput(homeImportFile);
    const homeImportFitBtn = createButton();
    const modalButtons = {
        confirmUploadBtn: createButton(),
        cancelUploadBtn: createButton()
    };
    modalButtons.confirmUploadBtn.parentNode = { replaceChild() {} };
    const modalInputs = {
        confirmActivityName: { value: "" },
        confirmMarkVirtual: { checked: true },
        confirmFitDescription: { value: "" }
    };
    const uploadConfirmOverlay = {
        classList: { add() {}, remove() {} },
        addEventListener() {},
        querySelector(selector) {
            const name = selector.replace(/^\[name="|"\]$/g, "");
            return modalInputs[name] ?? null;
        }
    };
    const uploadConfirmTemplate = {
        content: {
            cloneNode() {
                return {
                    type: "upload-confirm",
                    querySelector(sel) {
                        if (sel === "#uploadConfirmOverlay") return uploadConfirmOverlay;
                        if (sel === "#confirmUploadBtn") return modalButtons.confirmUploadBtn;
                        if (sel === "#cancelUploadBtn") return modalButtons.cancelUploadBtn;
                        return null;
                    }
                };
            }
        }
    };

    const document = {
        body: { appendChild() {} },
        getElementById(id) {
            return {
                homeImportFitInput,
                homeImportFitBtn,
                "upload-confirm-template": uploadConfirmTemplate,
                uploadConfirmOverlay,
                confirmUploadBtn: modalButtons.confirmUploadBtn,
                cancelUploadBtn: modalButtons.cancelUploadBtn
            }[id] ?? null;
        }
    };

    return {
        document,
        homeImportFile,
        homeImportFitInput,
        homeImportFitBtn,
        modalButtons
    };
}

export const suite = {
    name: "export-view",
    tests: [
        {
            name: "binds home FIT import without mounting a session export card",
            run() {
                const previousDocument = globalThis.document;
                const fake = createImportViewDocument();
                const importedFiles = [];

                globalThis.document = fake.document;
                try {
                    const view = createExportView({
                        onImportFit: (file) => { importedFiles.push(file); }
                    });

                    assert(view.elements.homeImportFitBtn, "首页 FIT 导入按钮应可绑定");
                    assert(view.elements.homeImportFitInput, "首页 FIT 导入 input 应可绑定");

                    fake.homeImportFitBtn.dispatch("click");
                    fake.homeImportFitInput.dispatch("change");

                    assertEqual(fake.homeImportFitInput.clickCount, 1);
                    assertEqual(importedFiles[0], fake.homeImportFile);
                    assertEqual(fake.homeImportFitInput.value, "");
                    view.render({ liveRide: { isActive: true } });
                    assertEqual(fake.homeImportFitBtn.disabled, true);
                } finally {
                    globalThis.document = previousDocument;
                }
            }
        }
    ]
};
