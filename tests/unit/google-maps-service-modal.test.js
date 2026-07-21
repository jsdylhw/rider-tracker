import { createGoogleMapsServiceModal } from "../../src/ui/views/google-maps-service-modal.js";
import { assert, assertEqual } from "../helpers/test-harness.js";
import { createFakeElement } from "../helpers/fake-dom.js";

export const suite = {
    name: "google-maps-service-modal",
    tests: [
        {
            name: "saves a replacement key and reloads when Maps is already initialized",
            async run() {
                let savedKey = "";
                let reloadCount = 0;
                const elements = {
                    googleMapsServiceOverlay: createFakeElement(),
                    googleMapsServiceTitle: createFakeElement(),
                    googleMapsServiceDescription: createFakeElement(),
                    googleMapsServiceApiKeyInput: createFakeElement({ focus() {} }),
                    googleMapsServiceStatus: createFakeElement(),
                    confirmGoogleMapsServiceBtn: createFakeElement(),
                    cancelGoogleMapsServiceBtn: createFakeElement()
                };
                const modal = createGoogleMapsServiceModal({
                    elements,
                    googleMapsConfig: {
                        getConfig: () => ({ apiKey: "key-a", apiKeyLocked: true }),
                        saveApiKeyForReload: (apiKey) => { savedKey = apiKey; }
                    },
                    reloadPage: () => { reloadCount += 1; }
                });

                const pending = modal.requestApiKey({ featureLabel: "加载街景", force: true });
                assert(elements.googleMapsServiceDescription.textContent.includes("自动刷新"));
                assertEqual(elements.confirmGoogleMapsServiceBtn.textContent, "更换 Key 并刷新");

                elements.googleMapsServiceApiKeyInput.value = "key-b";
                elements.confirmGoogleMapsServiceBtn.dispatch("click");
                const confirmedKey = await pending;

                assertEqual(confirmedKey, "");
                assertEqual(savedKey, "key-b");
                assertEqual(reloadCount, 1);
                assertEqual(elements.googleMapsServiceOverlay.classList.contains("open"), false);
            }
        }
    ]
};
