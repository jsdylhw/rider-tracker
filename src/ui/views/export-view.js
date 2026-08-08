export function createExportView({ onImportFit }) {
    const elements = {
        homeImportFitInput: document.getElementById("homeImportFitInput"),
        homeImportFitBtn: document.getElementById("homeImportFitBtn")
    };

    bindFitImport(elements.homeImportFitBtn, elements.homeImportFitInput, onImportFit);
    initializeUploadConfirmModal();

    return {
        elements,
        render(state) {
            if (elements.homeImportFitBtn) {
                elements.homeImportFitBtn.disabled = state.liveRide.isActive;
            }
        }
    };
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

let _modalElements = null;
let _pendingUpload = null;

function initializeUploadConfirmModal() {
    if (_modalElements) return;
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

    _modalElements = { overlay, nameInput, virtualCheckbox, descTextarea };

    bind(cancelBtn, "click", () => overlay?.classList.remove("open"));

    bind(confirmBtn, "click", () => {
        if (!_pendingUpload) return;
        const { onUpload, onUpdateExportMetadata: onUpdate } = _pendingUpload;
        const name = nameInput?.value?.trim() || "Rider Tracker Virtual Ride";
        const desc = descTextarea?.value?.trim() || "";
        const markVirtual = virtualCheckbox?.checked !== false;

        // Name and description are reusable preferences. Virtual/real is an
        // explicit decision for this upload only, so it must not become the
        // next ride's archive default.
        onUpdate?.({ activityName: name, fitDescription: desc });
        overlay?.classList.remove("open");
        onUpload?.({ activityName: name, fitDescription: desc, markVirtualActivity: markVirtual });
    });
}

function openUploadModal({ onUpload, onUpdateExportMetadata, getExportMetadata, initialValues }) {
    if (!_modalElements) return;
    const { overlay, nameInput, virtualCheckbox, descTextarea } = _modalElements;

    const meta = getExportMetadata?.() || {};
    const init = initialValues || {};
    if (nameInput) nameInput.value = init.activityName ?? meta.activityName ?? "";
    if (virtualCheckbox) virtualCheckbox.checked = init.markVirtualActivity === true;
    if (descTextarea) descTextarea.value = init.fitDescription ?? meta.fitDescription ?? "";

    _pendingUpload = { onUpload, onUpdateExportMetadata };

    overlay?.classList.add("open");
}

export { openUploadModal };
