export function createExportView({ onDownloadSession, onDownloadFit, onConnectStrava, onUploadFit }) {
    const exportCardContainer = document.getElementById("exportCardContainer");
    const exportCardTemplate = document.getElementById("export-card-template");
    mountSharedExportCard({ exportCardContainer, exportCardTemplate });

    const exportCardRoot = exportCardContainer ?? document;
    const elements = {
        exportCardContainer,
        liveExportSlot: document.getElementById("liveExportSlot"),
        exportCardTemplate,
        fitExportForm: exportCardRoot.querySelector("#fitExportForm"),
        downloadSessionBtn: exportCardRoot.querySelector("#downloadSessionBtn"),
        downloadFitBtn: exportCardRoot.querySelector("#downloadFitBtn"),
        connectStravaBtn: exportCardRoot.querySelector("#connectStravaBtn"),
        uploadFitBtn: exportCardRoot.querySelector("#uploadFitBtn")
    };

    bind(elements.downloadSessionBtn, "click", onDownloadSession);
    bind(elements.downloadFitBtn, "click", onDownloadFit);
    bind(elements.connectStravaBtn, "click", onConnectStrava);
    bind(elements.uploadFitBtn, "click", onUploadFit);

    return { elements };
}

function bind(el, event, handler) {
    if (el) el.addEventListener(event, handler);
}

function mountSharedExportCard({ exportCardContainer, exportCardTemplate }) {
    if (exportCardContainer && exportCardTemplate && exportCardContainer.childElementCount === 0) {
        exportCardContainer.appendChild(exportCardTemplate.content.cloneNode(true));
    }
}
