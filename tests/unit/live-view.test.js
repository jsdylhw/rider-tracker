import { createLiveView } from "../../src/ui/views/live-view.js";
import { assertEqual } from "../helpers/test-harness.js";
import { createFakeElement } from "../helpers/fake-dom.js";

function createDocumentHarness() {
    const elements = new Map();
    return {
        document: {
            getElementById(id) {
                if (!elements.has(id)) {
                    elements.set(id, createFakeElement());
                }
                return elements.get(id);
            },
            querySelectorAll() {
                return [];
            }
        },
        get(id) {
            return this.document.getElementById(id);
        }
    };
}

export const suite = {
    name: "live-view",
    tests: [
        {
            name: "editing a virtual input switches the debug ride source to virtual",
            run() {
                const previousDocument = globalThis.document;
                const harness = createDocumentHarness();
                globalThis.document = harness.document;
                const updates = [];

                try {
                    const view = createLiveView({
                        onUpdateRideInput: (input) => updates.push(input)
                    });
                    view.elements.ridePowerSourceSelect.value = "device";
                    view.elements.virtualPowerInput.value = "315";
                    view.elements.virtualCadenceInput.value = "92";

                    view.elements.virtualPowerInput.dispatch("input");

                    assertEqual(view.elements.ridePowerSourceSelect.value, "virtual");
                    assertEqual(updates[0].powerSource, "virtual");
                    assertEqual(updates[0].virtualPowerWatts, 315);
                    assertEqual(updates[0].virtualCadenceRpm, 92);
                } finally {
                    globalThis.document = previousDocument;
                }
            }
        }
    ]
};
