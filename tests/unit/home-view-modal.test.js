import { createHomeView } from "../../src/ui/views/home-view.js";
import { assertEqual } from "../helpers/test-harness.js";
import { createFakeElement } from "../helpers/fake-dom.js";

export const suite = {
    name: "home-view-modal",
    tests: [
        {
            name: "keeps ride settings open until the completion button is clicked",
            run() {
                const originalDocument = globalThis.document;
                const elements = {
                    openProfileSettingsBtn: createFakeElement(),
                    profileSettingsOverlay: createFakeElement(),
                    closeProfileSettingsBtn: createFakeElement()
                };
                globalThis.document = {
                    getElementById(id) { return elements[id] ?? null; },
                    querySelectorAll() { return []; }
                };

                try {
                    createHomeView({
                        onSetUiMode() {},
                        onEnterLiveMode() {},
                        onUpdateSettings() {}
                    });

                    elements.openProfileSettingsBtn.dispatch("click");
                    elements.profileSettingsOverlay.dispatch("click", { target: elements.profileSettingsOverlay });
                    assertEqual(elements.profileSettingsOverlay.classList.contains("open"), true);

                    elements.closeProfileSettingsBtn.dispatch("click");
                    assertEqual(elements.profileSettingsOverlay.classList.contains("open"), false);
                } finally {
                    globalThis.document = originalDocument;
                }
            }
        }
    ]
};
