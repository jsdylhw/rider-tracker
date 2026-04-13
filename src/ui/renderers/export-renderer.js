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

        if (elements.fitExportFormLive) {
            elements.fitExportFormLive.addEventListener("input", () => {
                onUpdateExportMetadata(readExportMetadataFromForm(elements.fitExportFormLive));
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
                    field.value = value;
                }
            }

            if (elements.fitExportFormLive) {
                const fieldLive = elements.fitExportFormLive.elements.namedItem(key);
                if (fieldLive && document.activeElement !== fieldLive) {
                    fieldLive.value = value;
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
            repositoryUrl: String(formData.get("repositoryUrl") ?? "")
        };
    }

    bindEvents();

    return {
        render
    };
}
