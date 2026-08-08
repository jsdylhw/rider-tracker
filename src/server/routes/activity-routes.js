import express from "express";
import fs from "node:fs";
import path from "node:path";
import { Decoder, Stream } from "@garmin/fitsdk";
import { buildSessionFromFitMessages } from "../../adapters/fit/fit-importer.js";
import { normalizeFileToken, normalizeText } from "../shared/http-utils.js";

export function createActivityRoutes({ activityStore, upload, fitFileDir, projectRoot }) {
    const router = express.Router();

    router.get("/api/activities", (req, res) => {
        try {
            const filters = {
                sportType: req.query.sportType,
                source: req.query.source
            };
            const limit = req.query.limit;
            const offset = req.query.offset;
            const history = activityStore.getActivityHistory({ ...filters, limit, offset });
            const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
            return res.json({
                ok: true,
                dbPath: activityStore.filePath,
                summary: history.summary,
                activities: history.activities,
                page: {
                    total: history.total,
                    offset: safeOffset,
                    limit: Number.parseInt(limit, 10) || 50,
                    hasMore: safeOffset + history.activities.length < history.total
                }
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

    router.post("/api/activities/fit-import", upload.single("file"), (req, res) => {
        try {
            const uploadedFile = req.file;
            const session = parseSessionField(req.body?.session);

            if (!uploadedFile) {
                return res.status(400).json({
                    ok: false,
                    error: "Missing FIT file. Send multipart field named file."
                });
            }
            if (!session) {
                return res.status(400).json({
                    ok: false,
                    error: "Missing compact session metadata."
                });
            }

            const activity = activityStore.saveRiderSession(session, {
                name: req.body?.name,
                sportType: req.body?.sportType || "Ride",
                source: session.source || "fit-import"
            });
            const savedActivity = saveFitFileForActivity({
                activity,
                uploadedFile,
                activityStore,
                fitFileDir,
                projectRoot
            });

            return res.json({
                ok: true,
                dbPath: activityStore.filePath,
                activity: savedActivity
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
            const activity = hydrateActivityDetailFromFit({
                activity: activityStore.getActivityDetail(req.params.activityId),
                projectRoot
            });
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

            const updatedActivity = saveFitFileForActivity({
                activity,
                uploadedFile,
                activityStore,
                fitFileDir,
                projectRoot
            });

            return res.json({
                ok: true,
                activity: updatedActivity,
                fitFile: {
                    path: updatedActivity.fitFilePath,
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

    router.post("/api/activities/fit-beacon", upload.single("file"), (req, res) => {
        try {
            const uploadedFile = req.file;
            const session = parseSessionField(req.body?.session);

            if (!uploadedFile) {
                return res.status(400).json({
                    ok: false,
                    error: "Missing FIT file. Send multipart field named file."
                });
            }
            if (!session) {
                return res.status(400).json({
                    ok: false,
                    error: "Missing compact session metadata."
                });
            }

            const activity = activityStore.saveRiderSession(session, {
                name: req.body?.name,
                sportType: req.body?.sportType || "Ride",
                source: session.source || "beacon"
            });
            const savedActivity = saveFitFileForActivity({
                activity,
                uploadedFile,
                activityStore,
                fitFileDir,
                projectRoot
            });

            return res.json({
                ok: true,
                activity: savedActivity
            });
        } catch (err) {
            return res.status(400).json({
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
            deleteFitFileIfLocal({
                activity,
                projectRoot
            });
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

function saveFitFileForActivity({ activity, uploadedFile, activityStore, fitFileDir, projectRoot }) {
    fs.mkdirSync(fitFileDir, { recursive: true });
    const safeOriginalName = normalizeFileToken(path.basename(uploadedFile.originalname || `${activity.id}.fit`));
    const filenameBase = safeOriginalName.endsWith(".fit") ? safeOriginalName : `${safeOriginalName}.fit`;
    const filename = `${normalizeFileToken(activity.id)}-${filenameBase}`;
    const fitPath = path.join(fitFileDir, filename);
    fs.writeFileSync(fitPath, uploadedFile.buffer);

    const relativePath = path.relative(projectRoot, fitPath).split(path.sep).join("/");
    return activityStore.updateActivityFitFile(activity.id, {
        fitFilePath: relativePath,
        fitFileSizeBytes: uploadedFile.buffer.length
    });
}

function parseSessionField(value) {
    if (!value) {
        return null;
    }
    if (typeof value === "object") {
        return value;
    }
    try {
        return JSON.parse(value);
    } catch (_error) {
        return null;
    }
}

function hydrateActivityDetailFromFit({ activity, projectRoot }) {
    if (!activity?.fitFilePath) {
        return activity;
    }

    const fitPath = path.resolve(projectRoot, activity.fitFilePath);
    if (!fitPath.startsWith(projectRoot) || !fs.existsSync(fitPath)) {
        return activity;
    }

    const fitBytes = fs.readFileSync(fitPath);
    const decoder = new Decoder(Stream.fromBuffer(fitBytes));
    const { messages, errors } = decoder.read();
    if (errors.length > 0) {
        return activity;
    }

    const { session } = buildSessionFromFitMessages({
        messages,
        fileName: path.basename(fitPath),
        settings: activity.rawSession?.settings ?? {}
    });

    return {
        ...activity,
        rawSession: {
            ...session,
            route: hasRouteGeometry(activity.rawSession?.route)
                ? activity.rawSession.route
                : session.route,
            activityId: activity.id,
            exportMetadata: {
                ...session.exportMetadata,
                activityName: activity.name
            }
        }
    };
}

function hasRouteGeometry(route) {
    const points = route?.mapGeometry?.length >= 2 ? route.mapGeometry : route?.points;
    return (points ?? []).filter((point) => {
        const latitude = point?.latitude ?? point?.lat;
        const longitude = point?.longitude ?? point?.lng;
        return Number.isFinite(latitude) && Number.isFinite(longitude);
    }).length >= 2;
}

function deleteFitFileIfLocal({ activity, projectRoot }) {
    if (!activity?.fitFilePath) {
        return;
    }

    const fitPath = path.resolve(projectRoot, activity.fitFilePath);
    if (!fitPath.startsWith(projectRoot) || !fs.existsSync(fitPath)) {
        return;
    }

    fs.unlinkSync(fitPath);
}
