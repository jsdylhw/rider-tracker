export function createExportView({ onDownloadSession, onDownloadFit, onImportFit, onConnectStrava, onUploadFit, onUploadActivityFit, onUpdateExportMetadata, getExportMetadata, getScreenshotSessionId }) {
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

    // Upload → show confirmation modal
    setupUploadModal({ onUploadFit, onUploadActivityFit, onUpdateExportMetadata, getExportMetadata, getScreenshotSessionId });

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

let _modalElements = null;
let _pendingUpload = null;
let _selectedScreenshotIds = [];
let _pickerWasShown = false;

function setupUploadModal({ onUploadFit, onUploadActivityFit, onUpdateExportMetadata, getExportMetadata, getScreenshotSessionId }) {
    const template = document.getElementById("upload-confirm-template");
    if (!template) return;

    const clone = template.content.cloneNode(true);
    document.body.appendChild(clone);

    const overlay = document.getElementById("uploadConfirmOverlay");
    const confirmBtn = document.getElementById("confirmUploadBtn");
    const cancelBtn = document.getElementById("cancelUploadBtn");
    const nameInput = overlay?.querySelector("[name=\"confirmActivityName\"]");
    const virtualCheckbox = overlay?.querySelector("[name=\"confirmMarkVirtual\"]");
    const descTextarea = overlay?.querySelector("[name=\"confirmFitDescription\"]");
    const pickerSection = document.getElementById("screenshotPickerSection");
    const swiperTrack = document.getElementById("swiperTrack");
    const countLabel = document.getElementById("screenshotCountLabel");
    const selectAllBtn = document.getElementById("selectAllScreenshotsBtn");
    const deselectAllBtn = document.getElementById("deselectAllScreenshotsBtn");

    _modalElements = { overlay, nameInput, virtualCheckbox, descTextarea, pickerSection, swiperTrack, countLabel };

    const uploadBtn = document.getElementById("uploadFitBtn");
    bind(uploadBtn, "click", () => {
        openUploadModal({ onUpload: onUploadFit, onUpdateExportMetadata, getExportMetadata, screenshotSessionId: getScreenshotSessionId?.() });
    });

    bind(cancelBtn, "click", closeUploadModal);
    bind(overlay, "click", (e) => {
        if (e.target === overlay) closeUploadModal();
    });

    bind(confirmBtn, "click", () => {
        if (!_pendingUpload) return;
        const { onUpload, onUpdateExportMetadata: onUpdate } = _pendingUpload;
        const name = nameInput?.value?.trim() || "Rider Tracker Virtual Ride";
        const desc = descTextarea?.value?.trim() || "";
        const markVirtual = virtualCheckbox?.checked !== false;

        onUpdate?.({ activityName: name, fitDescription: desc, markVirtualActivity: markVirtual });
        closeUploadModal();
        const hadPicker = _pickerWasShown;
        onUpload?.(_selectedScreenshotIds, hadPicker);
    });

    bind(selectAllBtn, "click", () => selectAllScreenshots());
    bind(deselectAllBtn, "click", () => deselectAllScreenshots());
}

function closeUploadModal() {
    _modalElements?.overlay?.classList.remove("open");
}

async function openUploadModal({ onUpload, onUpdateExportMetadata, getExportMetadata, initialValues, screenshotSessionId }) {
    if (!_modalElements) return;
    const { overlay, nameInput, virtualCheckbox, descTextarea, pickerSection, swiperTrack, countLabel } = _modalElements;

    const meta = getExportMetadata?.() || {};
    const init = initialValues || {};
    if (nameInput) nameInput.value = init.activityName ?? meta.activityName ?? "";
    if (virtualCheckbox) virtualCheckbox.checked = init.markVirtualActivity ?? (meta.markVirtualActivity !== false);
    if (descTextarea) descTextarea.value = init.fitDescription ?? meta.fitDescription ?? "";

    _pendingUpload = { onUpload, onUpdateExportMetadata };
    _selectedScreenshotIds = [];
    _pickerWasShown = false;

    if (screenshotSessionId) {
        await loadScreenshotsIntoPicker({ pickerSection, swiperTrack, countLabel, screenshotSessionId });
    } else if (pickerSection) {
        pickerSection.hidden = true;
    }

    overlay?.classList.add("open");
}

async function loadScreenshotsIntoPicker({ pickerSection, swiperTrack, countLabel, screenshotSessionId }) {
    if (!pickerSection || !swiperTrack) return;

    try {
        const url = new URL("/api/screenshots", window.location.origin);
        url.searchParams.set("sessionId", screenshotSessionId);
        const resp = await fetch(url.toString());
        const data = await resp.json();
        if (!data?.ok || !data.screenshots?.length) {
            pickerSection.hidden = true;
            return;
        }

        const screenshots = data.screenshots;
        pickerSection.hidden = false;
        _pickerWasShown = true;
        swiperTrack.innerHTML = screenshots.map((s, i) => `
            <div class="swiper-slide selected" data-index="${i}" data-id="${escapeHtmlAttr(s.screenshotId)}">
                <img src="/api/screenshots/file/${escapeHtmlAttr(screenshotSessionId)}/${escapeHtmlAttr(s.screenshotId)}" alt="截图 ${i + 1}" loading="lazy">
                <div class="swiper-slide-check"></div>
            </div>
        `).join("");

        // All selected by default
        _selectedScreenshotIds = screenshots.map((s) => s.screenshotId);
        if (countLabel) countLabel.textContent = `(已选 ${_selectedScreenshotIds.length}/${screenshots.length})`;

        // Click-to-toggle
        swiperTrack.querySelectorAll(".swiper-slide").forEach((slide) => {
            slide.addEventListener("click", () => toggleScreenshot(slide, countLabel, screenshots.length));
        });
    } catch {
        if (pickerSection) pickerSection.hidden = true;
    }
}

function toggleScreenshot(slide, countLabel, totalCount) {
    const id = slide.dataset.id;
    if (!id) return;

    const idx = _selectedScreenshotIds.indexOf(id);
    if (idx === -1) {
        _selectedScreenshotIds.push(id);
        slide.classList.add("selected");
    } else {
        _selectedScreenshotIds.splice(idx, 1);
        slide.classList.remove("selected");
    }

    if (countLabel) countLabel.textContent = `(已选 ${_selectedScreenshotIds.length}/${totalCount})`;
}

function selectAllScreenshots() {
    const { swiperTrack, countLabel } = _modalElements || {};
    if (!swiperTrack) return;

    const slides = swiperTrack.querySelectorAll(".swiper-slide");
    _selectedScreenshotIds = [];
    slides.forEach((slide) => {
        slide.classList.add("selected");
        _selectedScreenshotIds.push(slide.dataset.id);
    });

    if (countLabel) countLabel.textContent = `(已选 ${_selectedScreenshotIds.length}/${slides.length})`;
}

function deselectAllScreenshots() {
    const { swiperTrack, countLabel } = _modalElements || {};
    if (!swiperTrack) return;

    const slides = swiperTrack.querySelectorAll(".swiper-slide");
    _selectedScreenshotIds = [];
    slides.forEach((slide) => {
        slide.classList.remove("selected");
    });

    if (countLabel) countLabel.textContent = `(已选 0/${slides.length})`;
}

function escapeHtmlAttr(value) {
    return String(value ?? "").replace(/"/g, "&quot;").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export { openUploadModal };
