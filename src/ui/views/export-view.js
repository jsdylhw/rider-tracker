export function createExportView({ onDownloadSession, onDownloadFit, onConnectStrava, onUploadFit }) {
    const elements = {
        exportCardContainer: document.getElementById("exportCardContainer"),
        liveExportSlot: document.getElementById("liveExportSlot"),
        exportCardTemplate: document.getElementById("export-card-template"),
        fitExportForm: document.getElementById("fitExportForm"),
        downloadSessionBtn: document.getElementById("downloadSessionBtn"),
        downloadFitBtn: document.getElementById("downloadFitBtn"),
        connectStravaBtn: document.getElementById("connectStravaBtn"),
        uploadFitBtn: document.getElementById("uploadFitBtn")
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
