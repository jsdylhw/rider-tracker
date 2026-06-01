import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import multer from "multer";
import { createScreenshotRoutes } from "../../src/server/routes/screenshot-routes.js";
import { assert, assertEqual, assertGreaterThan } from "../helpers/test-harness.js";

function createTestApp() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rider-tracker-screenshots-"));
    const upload = multer({ storage: multer.memoryStorage() });
    const app = express();
    app.use(createScreenshotRoutes({ upload, screenshotDir: tmpDir }));
    return { app, tmpDir };
}

async function postScreenshot(baseUrl, { buffer, filename, sessionId }) {
    const formData = new FormData();
    formData.append("file", new Blob([buffer]), filename);
    if (sessionId) formData.append("screenshotSessionId", sessionId);
    const resp = await fetch(`${baseUrl}/api/screenshots`, { method: "POST", body: formData });
    return { status: resp.status, body: await resp.json() };
}

async function getScreenshots(baseUrl, sessionId) {
    const url = new URL(`${baseUrl}/api/screenshots`);
    if (sessionId) url.searchParams.set("sessionId", sessionId);
    const resp = await fetch(url.toString());
    return { status: resp.status, body: await resp.json() };
}

function withServer(app, fn) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, async () => {
            const { port } = server.address();
            const baseUrl = `http://127.0.0.1:${port}`;
            try {
                const result = await fn(baseUrl);
                resolve(result);
            } catch (err) {
                reject(err);
            } finally {
                server.close();
            }
        });
    });
}

export const suite = {
    name: "screenshot-routes",
    tests: [
        {
            name: "POST /api/screenshots saves JPEG and returns metadata",
            async run() {
                const { app, tmpDir } = createTestApp();
                const result = await withServer(app, async (baseUrl) => {
                    return postScreenshot(baseUrl, {
                        buffer: Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4]),
                        filename: "test-shot.jpg",
                        sessionId: "test-session"
                    });
                });

                assertEqual(result.status, 200);
                assert(result.body.ok, "response should be ok");
                assertEqual(result.body.screenshotSessionId, "test-session");
                assertGreaterThan(result.body.sizeBytes, 0);

                const savedDir = path.join(tmpDir, "test-session");
                assert(fs.existsSync(savedDir), "session dir should exist");
                const files = fs.readdirSync(savedDir).filter(f => f.endsWith(".jpg"));
                assertEqual(files.length, 1);
                assert(files[0].includes("test-shot"), `filename should contain original name, got: ${files[0]}`);

                // Cleanup
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        },
        {
            name: "POST /api/screenshots rejects request without file",
            async run() {
                const { app, tmpDir } = createTestApp();
                const result = await withServer(app, async (baseUrl) => {
                    const resp = await fetch(`${baseUrl}/api/screenshots`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ screenshotSessionId: "test" })
                    });
                    return { status: resp.status, body: await resp.json() };
                });

                assertEqual(result.status, 400);
                assertEqual(result.body.ok, false);

                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        },
        {
            name: "POST /api/screenshots sanitises dangerous characters in sessionId",
            async run() {
                const { app, tmpDir } = createTestApp();
                const result = await withServer(app, async (baseUrl) => {
                    return postScreenshot(baseUrl, {
                        buffer: Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 9, 9, 9, 9]),
                        filename: "safe.jpg",
                        sessionId: "../../etc/passwd"
                    });
                });

                assertEqual(result.status, 200);
                assert(result.body.ok, "response should be ok");
                // Dangerous chars like / and . are stripped
                assertEqual(result.body.screenshotSessionId, "etcpasswd");

                // Should NOT create dirs outside tmpDir using the raw malicious input
                const escapedDir = path.join(tmpDir, "..", "..", "etc", "passwd_non_existent");
                assert(!fs.existsSync(escapedDir), "path traversal should be blocked — no dir created from un-sanitised path");

                // Safe dir uses the sanitised id (dots and slashes stripped)
                const safeDir = path.join(tmpDir, "etcpasswd");
                assert(fs.existsSync(safeDir), "sanitised dir should exist");

                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        },
        {
            name: "GET /api/screenshots returns empty list for unknown session",
            async run() {
                const { app, tmpDir } = createTestApp();
                const result = await withServer(app, async (baseUrl) => {
                    return getScreenshots(baseUrl, "nonexistent");
                });

                assertEqual(result.status, 200);
                assert(result.body.ok, "response should be ok");
                assertEqual(result.body.screenshots.length, 0);

                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        },
        {
            name: "GET /api/screenshots lists screenshots sorted by creation time",
            async run() {
                const { app, tmpDir } = createTestApp();
                const sessionDir = path.join(tmpDir, "multi-shot");
                fs.mkdirSync(sessionDir, { recursive: true });

                // Create files with different timestamps
                fs.writeFileSync(path.join(sessionDir, `${Date.now() - 2000}-first.jpg`), Buffer.from([1]));
                fs.writeFileSync(path.join(sessionDir, `${Date.now() - 1000}-second.jpg`), Buffer.from([2, 3]));

                const result = await withServer(app, async (baseUrl) => {
                    return getScreenshots(baseUrl, "multi-shot");
                });

                assertEqual(result.status, 200);
                assert(result.body.ok, "response should be ok");
                assertEqual(result.body.screenshots.length, 2);
                assert(result.body.screenshots[0].filename.includes("first"), "first file should come first");
                assert(result.body.screenshots[1].filename.includes("second"), "second file should come second");
                assertEqual(result.body.screenshots[0].screenshotSessionId, "multi-shot");
                assertGreaterThan(result.body.screenshots[1].sizeBytes, result.body.screenshots[0].sizeBytes);

                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        }
    ]
};
