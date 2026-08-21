import { createAgentRouteDraftStorage } from "../../src/adapters/storage/agent-route-draft-storage.js";
import { assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "agent-route-draft-storage",
    tests: [
        {
            name: "persists and restores a route draft",
            run() {
                const values = new Map();
                const storage = {
                    getItem: (key) => values.get(key) ?? null,
                    setItem: (key, value) => values.set(key, value),
                    removeItem: (key) => values.delete(key),
                };
                const drafts = createAgentRouteDraftStorage({ storage });
                drafts.save({ planId: "plan-1", candidates: [{ candidateId: "c1" }] });
                assertEqual(drafts.load().planId, "plan-1");
                drafts.clear();
                assertEqual(drafts.load(), null);
            }
        }
    ]
};
