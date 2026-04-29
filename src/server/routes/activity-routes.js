import express from "express";
import fs from "node:fs";
import path from "node:path";
import { normalizeFileToken, normalizeText } from "../shared/http-utils.js";

export function createActivityRoutes({ activityStore, upload, fitFileDir, projectRoot }) {
    const router = express.Router();

    router.get("/api/activities", (req, res) => {
        try {
            const activities = activityStore.listActivities({
                limit: req.query.limit
            });
            return res.json({
                ok: true,
                dbPath: activityStore.filePath,
                summary: activityStore.getSummary(),
                activities
            });
        } catch (err) {
            return res.status(500).json({
                ok: false,
                error: err.message
            });
        }
    });

    router.post("/api/activities/rider-session", (req, res) => {
        try {
            const activity = activityStore.saveRiderSession(req.body?.session, {
                name: req.body?.name,
                sportType: req.body?.sportType
            });
            return res.json({
                ok: true,
                dbPath: activityStore.filePath,
                activity
            });
        } catch (err) {
            return res.status(400).json({
                ok: false,
                error: err.message
            });
        }
    });

    router.get("/api/activities/:activityId", (req, res) => {
        try {
            const activity = activityStore.getActivityDetail(req.params.activityId);
            if (!activity) {
                return res.status(404).json({
                    ok: false,
                    error: "Activity not found."
                });
            }

            return res.json({
                ok: true,
                activity
            });
        } catch (err) {
            return res.status(500).json({
                ok: false,
                error: err.message
            });
        }
    });

    router.post("/api/activities/:activityId/fit", upload.single("file"), (req, res) => {
        try {
            const activityId = normalizeText(req.params.activityId);
            const activity = activityStore.getActivity(activityId);
            const uploadedFile = req.file;

            if (!activity) {
                return res.status(404).json({
                    ok: false,
                    error: "Activity not found."
                });
            }

            if (!uploadedFile) {
                return res.status(400).json({
                    ok: false,
                    error: "Missing FIT file. Send multipart field named file."
                });
            }

            fs.mkdirSync(fitFileDir, { recursive: true });
            const safeOriginalName = normalizeFileToken(path.basename(uploadedFile.originalname || `${activityId}.fit`));
            const filenameBase = safeOriginalName.endsWith(".fit") ? safeOriginalName : `${safeOriginalName}.fit`;
            const filename = `${normalizeFileToken(activityId)}-${filenameBase}`;
            const fitPath = path.join(fitFileDir, filename);
            fs.writeFileSync(fitPath, uploadedFile.buffer);

            const relativePath = path.relative(projectRoot, fitPath).split(path.sep).join("/");
            const updatedActivity = activityStore.updateActivityFitFile(activityId, {
                fitFilePath: relativePath,
                fitFileSizeBytes: uploadedFile.buffer.length
            });

            return res.json({
                ok: true,
                activity: updatedActivity,
                fitFile: {
                    path: relativePath,
                    sizeBytes: uploadedFile.buffer.length
                }
            });
        } catch (err) {
            return res.status(500).json({
                ok: false,
                error: err.message
            });
        }
    });

    router.patch("/api/activities/:activityId", (req, res) => {
        try {
            const activity = activityStore.updateActivityName(req.params.activityId, req.body?.name);
            return res.json({
                ok: true,
                activity
            });
        } catch (err) {
            return res.status(err.message === "Activity not found." ? 404 : 400).json({
                ok: false,
                error: err.message
            });
        }
    });

    router.delete("/api/activities/:activityId", (req, res) => {
        try {
            const activity = activityStore.deleteActivity(req.params.activityId);
            return res.json({
                ok: true,
                activity
            });
        } catch (err) {
            return res.status(err.message === "Activity not found." ? 404 : 400).json({
                ok: false,
                error: err.message
            });
        }
    });

    return router;
}
