import express from "express";
import fs from "node:fs";
import path from "node:path";

export function createScreenshotRoutes({ upload, screenshotDir }) {
    const router = express.Router();

    router.post("/api/screenshots", upload.single("file"), (req, res) => {
        try {
            const file = req.file;
            if (!file) {
                return res.status(400).json({ ok: false, error: "Missing file." });
            }

            const screenshotSessionId = (req.body?.screenshotSessionId || "default").replace(/[^a-zA-Z0-9_-]/g, "");
            const dir = path.join(screenshotDir, screenshotSessionId);
            fs.mkdirSync(dir, { recursive: true });

            const originalName = file.originalname || `screenshot-${Date.now()}.jpg`;
            const safeName = path.basename(originalName).replace(/[^a-zA-Z0-9._-]/g, "");
            const filename = `${Date.now()}-${safeName}`;
            const filePath = path.join(dir, filename);

            fs.writeFileSync(filePath, file.buffer);

            res.json({
                ok: true,
                screenshotId: filename,
                filename,
                screenshotSessionId,
                sizeBytes: file.size
            });
        } catch (error) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    router.get("/api/screenshots", (req, res) => {
        try {
            const sessionId = (req.query.sessionId || "default").replace(/[^a-zA-Z0-9_-]/g, "");
            const dir = path.join(screenshotDir, sessionId);

            if (!fs.existsSync(dir)) {
                return res.json({ ok: true, screenshots: [] });
            }

            const files = fs.readdirSync(dir)
                .filter((f) => /\.(jpg|jpeg|png|gif)$/i.test(f))
                .map((f) => {
                    const stat = fs.statSync(path.join(dir, f));
                    return {
                        screenshotId: f,
                        filename: f,
                        screenshotSessionId: sessionId,
                        sizeBytes: stat.size,
                        createdAt: stat.birthtime?.toISOString() ?? stat.mtime.toISOString()
                    };
                })
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

            res.json({ ok: true, screenshots: files });
        } catch (error) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    router.get("/api/screenshots/file/:sessionId/:screenshotId", (req, res) => {
        try {
            const sessionId = (req.params.sessionId || "").replace(/[^a-zA-Z0-9_-]/g, "");
            const screenshotId = (req.params.screenshotId || "").replace(/[^a-zA-Z0-9._-]/g, "");
            if (!sessionId || !screenshotId) {
                return res.status(400).json({ ok: false, error: "Missing sessionId or screenshotId." });
            }

            const filePath = path.join(screenshotDir, sessionId, screenshotId);
            const root = path.resolve(screenshotDir);
            if (!path.resolve(filePath).startsWith(root)) {
                return res.status(403).json({ ok: false, error: "Path traversal denied." });
            }

            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ ok: false, error: "Screenshot not found." });
            }

            res.sendFile(filePath);
        } catch (error) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    return router;
}
