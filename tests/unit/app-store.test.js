import { createStore } from "../../src/app/store/app-store.js";
import { assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "app-store",
    tests: [
        {
            name: "subscribe receives the previous state after an update",
            run() {
                const store = createStore({ count: 0 });
                const transitions = [];
                store.subscribe((state, previousState) => {
                    transitions.push({ state, previousState });
                });

                store.setState((state) => ({ ...state, count: 1 }));

                assertEqual(transitions.length, 2);
                assertEqual(transitions[0].previousState, undefined);
                assertEqual(transitions[1].previousState.count, 0);
                assertEqual(transitions[1].state.count, 1);
            }
        }
    ]
};
