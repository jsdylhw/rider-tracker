export function createExportRenderer({
    elements,
    onUpdateExportMetadata
}) {
    let lastRenderedExportSignature = "";

    function bindEvents() {
        if (elements.fitExportForm) {
            elements.fitExportForm.addEventListener("input", () => {
                onUpdateExportMetadata(readExportMetadataFromForm(elements.fitExportForm));
            });
        }
    }

    function render(state) {
        const signature = JSON.stringify(state.exportMetadata);

        if (signature === lastRenderedExportSignature) {
            return;
        }

        Object.entries(state.exportMetadata).forEach(([key, value]) => {
            if (elements.fitExportForm) {
                const field = elements.fitExportForm.elements.namedItem(key);
                if (field && document.activeElement !== field) {
                    if (field.type === "checkbox") {
                        field.checked = Boolean(value);
                    } else {
                        field.value = value;
                    }
                }
            }
        });

        lastRenderedExportSignature = signature;
    }

    function readExportMetadataFromForm(form) {
        const formData = new FormData(form);

        return {
            activityName: String(formData.get("activityName") ?? ""),
            fitDescription: String(formData.get("fitDescription") ?? ""),
            repositoryUrl: String(formData.get("repositoryUrl") ?? ""),
            uploadEndpoint: String(formData.get("uploadEndpoint") ?? ""),
            stravaServerUrl: String(formData.get("stravaServerUrl") ?? ""),
            stravaUserId: String(formData.get("stravaUserId") ?? ""),
            markVirtualActivity: Boolean(formData.get("markVirtualActivity"))
        };
    }

    bindEvents();

    return {
        render
    };
}
