import { createGoogleMapsConfigService } from "../../src/app/services/google-maps-config-service.js";
import { assert, assertEqual } from "../helpers/test-harness.js";

function createStorage() {
    const values = new Map();
    return {
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) { values.set(key, value); },
        removeItem(key) { values.delete(key); }
    };
}

export const suite = {
    name: "google-maps-config-service",
    tests: [
        {
            name: "keeps one Google Key in browser-local runtime config",
            run() {
                const storage = createStorage();
                const service = createGoogleMapsConfigService({ storage });

                service.updateConfig({
                    apiKey: " test-key "
                });

                assertEqual(service.getApiKey(), "test-key");
                assertEqual(createGoogleMapsConfigService({ storage }).getApiKey(), "test-key");
            }
        },
        {
            name: "locks the API key after Google Maps initializes",
            run() {
                const service = createGoogleMapsConfigService({ storage: createStorage() });
                service.updateConfig({ apiKey: "key-a" });
                service.lockApiKey("key-a");
                service.updateConfig({ apiKey: "key-a" });

                assertEqual(service.getConfig().apiKey, "key-a");
                let error = null;
                try {
                    service.updateConfig({ apiKey: "key-b" });
                } catch (caught) {
                    error = caught;
                }
                assert(Boolean(error), "changing a loaded Google Maps key should require a page refresh");
            }
        },
        {
            name: "uses the profile key as the startup configuration source",
            run() {
                const storage = createStorage();
                storage.setItem("rider-tracker:google-maps-api-key", "stale-browser-key");
                const service = createGoogleMapsConfigService({ storage });

                service.applyProfileApiKey(" profile-key ");

                assertEqual(service.getApiKey(), "profile-key");
                assertEqual(storage.getItem("rider-tracker:google-maps-api-key"), "profile-key");
            }
        }
    ]
};
