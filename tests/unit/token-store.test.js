import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTokenStore } from "../../src/server/token-store.js";
import { assert, assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "token-store",
    tests: [
        {
            name: "serializes concurrent token writes without dropping users",
            async run() {
                const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rider-tracker-tokens-"));
                const storePath = path.join(tempDir, "strava-tokens.json");
                const store = createTokenStore(storePath);
                const writes = Array.from({ length: 20 }, (_, index) => {
                    const userId = `user-${index}`;
                    return store.set(userId, {
                        access_token: `access-${index}`,
                        refresh_token: `refresh-${index}`
                    });
                });

                await Promise.all(writes);

                for (let index = 0; index < writes.length; index += 1) {
                    const token = await store.get(`user-${index}`);
                    assert(token, `token for user-${index} should exist`);
                    assertEqual(token.access_token, `access-${index}`);
                    assertEqual(token.refresh_token, `refresh-${index}`);
                }
            }
        },
        {
            name: "waits for queued writes before reading",
            async run() {
                const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rider-tracker-tokens-"));
                const storePath = path.join(tempDir, "strava-tokens.json");
                const store = createTokenStore(storePath);

                const pendingWrite = store.set("default", {
                    access_token: "queued-access"
                });
                const token = await store.get("default");

                await pendingWrite;
                assertEqual(token.access_token, "queued-access");
            }
        }
    ]
};
