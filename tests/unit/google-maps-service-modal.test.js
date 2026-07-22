import { createGoogleMapsServiceModal } from "../../src/ui/views/google-maps-service-modal.js";
import { assert, assertEqual } from "../helpers/test-harness.js";
import { createFakeElement } from "../helpers/fake-dom.js";

export const suite = {
    name: "google-maps-service-modal",
    tests: [
        {
            name: "keeps the key dialog open until the user explicitly closes it",
            async run() {
                let updatedKey = "";
                const elements = {
                    googleMapsServiceOverlay: createFakeElement(),
                    googleMapsServiceTitle: createFakeElement(),
                    googleMapsServiceDescription: createFakeElement(),
                    googleMapsServiceApiKeyInput: createFakeElement({ focus() {} }),
                    googleMapsServiceStatus: createFakeElement(),
                    confirmGoogleMapsServiceBtn: createFakeElement(),
                    cancelGoogleMapsServiceBtn: createFakeElement(),
                    closeGoogleMapsServiceBtn: createFakeElement()
                };
                const modal = createGoogleMapsServiceModal({
                    elements,
                    googleMapsConfig: {
                        getConfig: () => ({ apiKey: "", apiKeyLocked: false }),
                        updateConfig: ({ apiKey }) => { updatedKey = apiKey; }
                    }
                });

                const pending = modal.requestApiKey({ featureLabel: "加载街景", force: true });
                assert(elements.googleMapsServiceDescription.textContent.includes("再次请求"));
                assertEqual(elements.confirmGoogleMapsServiceBtn.textContent, "连接街景");

                elements.googleMapsServiceApiKeyInput.value = "key-b";
                elements.confirmGoogleMapsServiceBtn.dispatch("click");
                const confirmedKey = await pending;

                assertEqual(confirmedKey, "key-b");
                assertEqual(updatedKey, "key-b");
                assertEqual(elements.googleMapsServiceOverlay.classList.contains("open"), false);

                const secondPending = modal.requestApiKey({ featureLabel: "加载街景", force: true });
                elements.googleMapsServiceOverlay.dispatch("click", { target: elements.googleMapsServiceOverlay });
                assertEqual(elements.googleMapsServiceOverlay.classList.contains("open"), true);
                elements.closeGoogleMapsServiceBtn.dispatch("click");
                assertEqual(await secondPending, "");
                assertEqual(elements.googleMapsServiceOverlay.classList.contains("open"), false);
            }
        }
    ]
};
