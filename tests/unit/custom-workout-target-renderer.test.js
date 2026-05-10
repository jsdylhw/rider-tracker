import { createCustomWorkoutTargetRenderer } from "../../src/ui/renderers/custom-workout-target-renderer.js";
import { assertEqual } from "../helpers/test-harness.js";
import { createFakeElement } from "../helpers/fake-dom.js";

export const suite = {
    name: "custom-workout-target-renderer",
    tests: [
        {
            name: "目标计划开关整块区域可点击切换",
            run() {
                const updates = [];
                const input = createFakeElement({ checked: false, disabled: false });
                const toggle = createFakeElement();

                createCustomWorkoutTargetRenderer({
                    elements: {
                        customWorkoutTargetEnabled: input,
                        customWorkoutTargetToggle: toggle
                    },
                    onUpdateCustomWorkoutTargetEnabled: (enabled) => updates.push(enabled)
                });

                toggle.dispatch("click", { preventDefault() {} });
                assertEqual(input.checked, true);
                assertEqual(updates.at(-1), true);

                toggle.dispatch("click", { preventDefault() {} });
                assertEqual(input.checked, false);
                assertEqual(updates.at(-1), false);
            }
        },
        {
            name: "目标计划开关禁用时不会切换",
            run() {
                const updates = [];
                const input = createFakeElement({ checked: false, disabled: true });
                const toggle = createFakeElement();

                createCustomWorkoutTargetRenderer({
                    elements: {
                        customWorkoutTargetEnabled: input,
                        customWorkoutTargetToggle: toggle
                    },
                    onUpdateCustomWorkoutTargetEnabled: (enabled) => updates.push(enabled)
                });

                toggle.dispatch("click", { preventDefault() {} });
                assertEqual(input.checked, false);
                assertEqual(updates.length, 0);
            }
        }
    ]
};
