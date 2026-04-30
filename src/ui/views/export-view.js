export function createExportView({ onDownloadSession, onDownloadFit, onImportFit, onConnectStrava, onUploadFit }) {
    const exportCardContainer = document.getElementById("exportCardContainer");
    const exportCardTemplate = document.getElementById("export-card-template");
    mountSharedExportCard({ exportCardContainer, exportCardTemplate });

    const exportCardRoot = exportCardContainer ?? document;
    const elements = {
        exportCardContainer,
        liveExportSlot: document.getElementById("liveExportSlot"),
        exportCardTemplate,
        homeImportFitInput: document.getElementById("homeImportFitInput"),
        homeImportFitBtn: document.getElementById("homeImportFitBtn"),
        fitExportForm: exportCardRoot.querySelector("#fitExportForm"),
        downloadSessionBtn: exportCardRoot.querySelector("#downloadSessionBtn"),
        downloadFitBtn: exportCardRoot.querySelector("#downloadFitBtn"),
        importFitInput: exportCardRoot.querySelector("#importFitInput"),
        importFitBtn: exportCardRoot.querySelector("#importFitBtn"),
        connectStravaBtn: exportCardRoot.querySelector("#connectStravaBtn"),
        uploadFitBtn: exportCardRoot.querySelector("#uploadFitBtn")
    };

    bind(elements.downloadSessionBtn, "click", onDownloadSession);
    bind(elements.downloadFitBtn, "click", onDownloadFit);
    bindFitImport(elements.importFitBtn, elements.importFitInput, onImportFit);
    bindFitImport(elements.homeImportFitBtn, elements.homeImportFitInput, onImportFit);
    bind(elements.connectStravaBtn, "click", onConnectStrava);
    bind(elements.uploadFitBtn, "click", onUploadFit);

    return { elements };
}

function bind(el, event, handler) {
    if (el) el.addEventListener(event, handler);
}

function bindFitImport(button, input, handler) {
    bind(button, "click", () => {
        input?.click();
    });
    bind(input, "change", () => {
        const file = input?.files?.[0];
        if (file) {
            handler?.(file);
            input.value = "";
        }
    });
}

function mountSharedExportCard({ exportCardContainer, exportCardTemplate }) {
    if (exportCardContainer && exportCardTemplate && exportCardContainer.childElementCount === 0) {
        exportCardContainer.appendChild(exportCardTemplate.content.cloneNode(true));
    }
}
