import { createStravaClient } from "../../src/server/strava-client.js";
import { assert, assertEqual } from "../helpers/test-harness.js";

function createClient() {
    return createStravaClient({
        clientId: "test-id",
        clientSecret: "test-secret",
        redirectUri: "http://localhost/callback",
        scopes: "activity:write"
    });
}

function mockFetch(responseFactory) {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        return responseFactory(url, init);
    };
    return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

export const suite = {
    name: "strava-photo-upload",
    tests: [
        {
            name: "uploadActivityPhoto sends correct POST to Strava photos endpoint",
            async run() {
                const client = createClient();
                const { calls, restore } = mockFetch(() => ({
                    ok: true,
                    status: 201,
                    text: async () => JSON.stringify({ id: 999, unique_id: "photo-abc" })
                }));

                try {
                    const result = await client.uploadActivityPhoto({
                        accessToken: "token-123",
                        activityId: 45678,
                        fileBuffer: Buffer.from([1, 2, 3]),
                        filename: "screenshot.jpg"
                    });

                    assertEqual(calls.length, 1);
                    assertEqual(calls[0].url, "https://www.strava.com/api/v3/activities/45678/photos");
                    assertEqual(calls[0].init.method, "POST");
                    assertEqual(calls[0].init.headers.Authorization, "Bearer token-123");

                    const formData = calls[0].init.body;
                    assert(formData instanceof FormData, "body should be FormData");
                    assertEqual(result.id, 999);
                    assertEqual(result.unique_id, "photo-abc");
                } finally {
                    restore();
                }
            }
        },
        {
            name: "uploadActivityPhoto URL-encodes activity ID",
            async run() {
                const client = createClient();
                const { calls, restore } = mockFetch(() => ({
                    ok: true,
                    status: 201,
                    text: async () => JSON.stringify({ id: 1 })
                }));

                try {
                    await client.uploadActivityPhoto({
                        accessToken: "t",
                        activityId: "abc/123",
                        fileBuffer: Buffer.from([]),
                        filename: "x.jpg"
                    });

                    // The / in activityId should be encoded
                    assert(calls[0].url.includes("abc%2F123"), `URL should encode activityId, got: ${calls[0].url}`);
                } finally {
                    restore();
                }
            }
        },
        {
            name: "uploadActivityPhoto throws on non-ok response",
            async run() {
                const client = createClient();
                const { restore } = mockFetch(() => ({
                    ok: false,
                    status: 401,
                    text: async () => JSON.stringify({ message: "Unauthorized" })
                }));

                try {
                    let threw = false;
                    try {
                        await client.uploadActivityPhoto({
                            accessToken: "bad-token",
                            activityId: 123,
                            fileBuffer: Buffer.from([]),
                            filename: "x.jpg"
                        });
                    } catch (err) {
                        threw = true;
                        assert(err.message.includes("Strava photo upload failed"), `unexpected message: ${err.message}`);
                        assert(err.message.includes("401"), `should include status code, got: ${err.message}`);
                        assert(err.message.includes("Unauthorized"), `should include error message, got: ${err.message}`);
                    }
                    assert(threw, "should have thrown");
                } finally {
                    restore();
                }
            }
        },
        {
            name: "uploadActivityPhoto handles network errors",
            async run() {
                const client = createClient();
                const { restore } = mockFetch(() => {
                    throw new Error("ECONNREFUSED");
                });

                try {
                    let threw = false;
                    try {
                        await client.uploadActivityPhoto({
                            accessToken: "t",
                            activityId: 123,
                            fileBuffer: Buffer.from([]),
                            filename: "x.jpg"
                        });
                    } catch (err) {
                        threw = true;
                        assert(err.message.includes("ECONNREFUSED"), `unexpected message: ${err.message}`);
                    }
                    assert(threw, "should have thrown on network error");
                } finally {
                    restore();
                }
            }
        }
    ]
};
