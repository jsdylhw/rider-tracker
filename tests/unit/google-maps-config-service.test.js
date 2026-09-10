import { createGoogleMapsConfigService } from "../../src/app/services/google-maps-config-service.js";
import { assert, assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "google-maps-config-service",
    tests: [
        {
            name: "uses config.yaml as the only Google Key source",
            async run() {
                const service = createGoogleMapsConfigService({
                    fetchImpl: async () => ({
                        ok: true,
                        async json() { return { configured: true, apiKey: " config-key " }; }
                    })
                });

                await service.loadRuntimeConfig();

                assertEqual(service.getApiKey(), "config-key");
                assertEqual(service.getConfig().source, "config");
            }
        },
        {
            name: "keeps online map features unavailable when config has no key",
            async run() {
                const service = createGoogleMapsConfigService({
                    fetchImpl: async () => ({
                        ok: true,
                        async json() { return { configured: false, apiKey: "" }; }
                    })
                });

                await service.loadRuntimeConfig();

                assertEqual(service.getApiKey(), "");
                assertEqual(service.getConfig().source, "none");
            }
        },
        {
            name: "locks the unified key after Google Maps initializes",
            async run() {
                let key = "key-a";
                const service = createGoogleMapsConfigService({
                    fetchImpl: async () => ({
                        ok: true,
                        async json() { return { configured: true, apiKey: key }; }
                    })
                });
                await service.loadRuntimeConfig();
                service.lockApiKey("key-a");
                key = "key-b";
                await service.loadRuntimeConfig();

                assertEqual(service.getApiKey(), "key-a");
                assert(Boolean(service.getConfig().apiKeyLocked));
            }
        }
    ]
};
