import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeFileToken, normalizeText } from "../shared/http-utils.js";
import { createAgentUnavailableError, sendAgentUnavailable } from "../agent-unavailable.js";
import { DEFAULT_ACTIVITY_LIBRARY_TIMEOUT_MS } from "../personal-fit-agent-client.js";

export function createActivityRoutes({ agentClient, upload, fitFileDir, projectRoot }) {
    const router = express.Router();
    const libraryHandlers = createActivityLibraryHandlers({ agentClient });

    router.get("/api/activities", libraryHandlers.list);
    router.post("/api/activities/rider-session", createRiderSessionArchiveHandler({ agentClient }));

    router.post("/api/activities/fit-import", upload.single("file"), async (req, res) => {
        try {
            const uploadedFile = req.file;
            const session = parseSessionField(req.body?.session);

            if (!uploadedFile) {
                return res.status(400).json({
                    ok: false,
                    error: "Missing FIT file. Send multipart field named file."
                });
            }
            const activityId = `fit-${crypto.createHash("sha256").update(uploadedFile.buffer).digest("hex").slice(0, 16)}`;
            const savedFit = saveFitFile({
                activityId,
                uploadedFile,
                fitFileDir,
                projectRoot
            });
            const ingestion = await agentClient.ingestFit({
                path: savedFit.relativePath,
                activity_id: activityId,
                source: "fit-import",
                name: normalizeText(req.body?.name) || path.basename(uploadedFile.originalname || activityId),
                route_link: routeLinkFromSession(session)
            });
            const savedActivity = canonicalDetailToRiderActivity(ingestion.detail, {
                ...(ingestion.rider_activity ?? {}),
                rawSession: session
            });

            return res.json({
                ok: true,
                activity: savedActivity
            });
        } catch (err) {
            return sendActivityWriteError(res, err, { fallbackStatus: 400 });
        }
    });

    router.get("/api/activities/:activityId", libraryHandlers.get);

    router.post("/api/activities/:activityId/fit", upload.single("file"), async (req, res) => {
        try {
            const activityId = normalizeText(req.params.activityId);
            const activity = (await agentClient.getActivity(activityId)).activity;
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

            const savedFit = saveFitFile({
                activityId,
                uploadedFile,
                fitFileDir,
                projectRoot
            });
            const ingestion = await agentClient.ingestFit({
                path: savedFit.relativePath,
                activity_id: activityId,
                source: activity.source || "rider-tracker",
                name: activity.name
            });
            const updatedActivity = canonicalDetailToRiderActivity(ingestion.detail, {
                ...activity,
                ...(ingestion.rider_activity ?? {})
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
            return sendActivityWriteError(res, err, { fallbackStatus: 500 });
        }
    });

    router.post("/api/activities/fit-beacon", upload.single("file"), async (req, res) => {
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

            let activity = (await agentClient.archiveRiderSession({
                session: session.source ? session : { ...session, source: "beacon" },
                name: req.body?.name,
                sportType: req.body?.sportType || "Ride"
            })).activity;
            const savedFit = saveFitFile({
                activityId: activity.id,
                uploadedFile,
                fitFileDir,
                projectRoot
            });
            const ingestion = await agentClient.ingestFit({
                path: savedFit.relativePath,
                activity_id: activity.id,
                source: activity.source || "beacon",
                name: activity.name,
                route_link: routeLinkFromSession(session)
            });
            const savedActivity = canonicalDetailToRiderActivity(ingestion.detail, {
                ...activity,
                ...(ingestion.rider_activity ?? {})
            });

            return res.json({
                ok: true,
                activity: savedActivity
            });
        } catch (err) {
            return sendActivityWriteError(res, err, { fallbackStatus: 400 });
        }
    });

    router.patch("/api/activities/:activityId", libraryHandlers.rename);
    router.delete("/api/activities/:activityId", libraryHandlers.remove);

    return router;
}

export function createRiderSessionArchiveHandler({ agentClient }) {
    return async (req, res) => {
        try {
            const result = await agentClient.archiveRiderSession({
                session: req.body?.session,
                name: req.body?.name,
                sportType: req.body?.sportType
            });
            return res.status(200).json({ ok: true, ...result });
        } catch (error) {
            if (sendAgentUnavailable(res, error, { capability: "activity_archive" })) return;
            return res.status(Number(error?.statusCode) || 500).json({
                ok: false,
                error: error.message,
                ...(error?.code ? { code: error.code } : {}),
                ...(typeof error?.retryable === "boolean" ? { retryable: error.retryable } : {})
            });
        }
    };
}

export function sendActivityWriteError(res, error, { fallbackStatus }) {
    if (sendAgentUnavailable(res, error, { capability: "fit_ingestion" })) return res;
    return res.status(Number(error?.statusCode) || fallbackStatus).json({
        ok: false,
        error: error.message,
        ...(error?.code ? { code: error.code } : {}),
        ...(typeof error?.retryable === "boolean" ? { retryable: error.retryable } : {})
    });
}

export function createActivityLibraryHandlers({
    agentClient,
    timeoutMs = DEFAULT_ACTIVITY_LIBRARY_TIMEOUT_MS,
    now = Date.now
}) {
    return {
        list: (req, res) => proxyActivityLibrary(res, () => agentClient.listActivities({
            limit: req.query?.limit,
            offset: req.query?.offset,
            sportType: req.query?.sportType || "",
            source: req.query?.source || ""
        })),
        get: (req, res) => proxyActivityLibrary(res, async () => {
            const deadline = now() + timeoutMs;
            const result = await agentClient.getActivity(req.params.activityId, {
                requestTimeoutMs: remainingActivityLibraryTime(deadline, now)
            });
            const storedActivity = result?.activity ?? null;
            const activity = storedActivity?.fitFilePath
                ? canonicalDetailToRiderActivity(
                    await agentClient.activityDetail(req.params.activityId, {
                        requestTimeoutMs: remainingActivityLibraryTime(deadline, now)
                    }),
                    storedActivity
                )
                : storedActivity;
            return { activity };
        }),
        rename: (req, res) => proxyActivityLibrary(res, () => (
            agentClient.renameActivity(req.params.activityId, req.body?.name)
        )),
        remove: (req, res) => proxyActivityLibrary(res, () => (
            agentClient.deleteActivity(req.params.activityId)
        ))
    };
}

function remainingActivityLibraryTime(deadline, now) {
    const remainingMs = Math.floor(deadline - now());
    if (remainingMs <= 0) {
        throw createAgentUnavailableError("Training Agent 未能在活动详情读取时限内响应。");
    }
    return remainingMs;
}

async function proxyActivityLibrary(res, callback) {
    try {
        const result = await callback();
        return res.status(200).json({ ok: true, ...result });
    } catch (error) {
        if (sendAgentUnavailable(res, error, { capability: "activity_library" })) return;
        return res.status(Number(error?.statusCode) || 500).json({
            ok: false,
            error: error.message,
            ...(error?.code ? { code: error.code } : {}),
            ...(typeof error?.retryable === "boolean" ? { retryable: error.retryable } : {})
        });
    }
}

function saveFitFile({ activityId, uploadedFile, fitFileDir, projectRoot }) {
    fs.mkdirSync(fitFileDir, { recursive: true });
    const filename = `${normalizeFileToken(activityId)}.fit`;
    const fitPath = path.join(fitFileDir, filename);
    fs.writeFileSync(fitPath, uploadedFile.buffer);

    const relativePath = path.relative(projectRoot, fitPath).split(path.sep).join("/");
    return { fitPath, relativePath };
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

export function routeLinkFromSession(session) {
    const route = session?.route;
    if (!route?.savedRouteId) return null;
    const startDistanceMeters = finiteOrZero(
        route.continuation?.startDistanceMeters ?? route.savedRouteResumeDistanceMeters
    );
    const sessionDistanceMeters = finiteOrZero(
        session?.summary?.metrics?.ride?.distanceKm ?? session?.summary?.distanceKm
    ) * 1000;
    return {
        saved_route_id: route.savedRouteId,
        start_distance_meters: startDistanceMeters,
        end_distance_meters: startDistanceMeters + sessionDistanceMeters
    };
}

function finiteOrZero(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

export function canonicalDetailToRiderActivity(detail, fallback = {}) {
    const activity = detail?.activity ?? {};
    const metrics = detail?.metrics ?? {};
    const scale = metrics.scale ?? {};
    const power = metrics.power ?? {};
    const heartRate = metrics.heart_rate ?? {};
    const cadence = metrics.cadence ?? {};
    const performance = metrics.performance ?? {};
    const fallbackEnergy = fallback.rawSession?.summary?.metrics?.energy ?? {};
    const analysisReport = Object.prototype.hasOwnProperty.call(detail ?? {}, "report")
        ? detail.report
        : (fallback.analysisReport ?? null);
    const records = buildRiderRecords(detail?.series?.records ?? []);
    const points = records
        .filter((record) => Number.isFinite(record.positionLat) && Number.isFinite(record.positionLong))
        .map((record) => ({
            latitude: record.positionLat,
            longitude: record.positionLong,
            elevationMeters: record.elevationMeters,
            distanceMeters: record.distanceKm * 1000
        }));
    const existingRoute = fallback.rawSession?.route;
    const route = hasRouteGeometry(existingRoute)
        ? existingRoute
        : {
            source: "fit-import",
            points,
            mapGeometry: points,
            totalDistanceMeters: (scale.distance_km ?? 0) * 1000,
            totalElevationGainMeters: scale.total_ascent_m ?? 0,
            hasElevationData: records.some((record) => Number.isFinite(record.elevationMeters))
        };
    const summaryMetrics = {
        ride: {
            elapsedSeconds: scale.duration_s ?? 0,
            distanceKm: scale.distance_km ?? 0,
            ascentMeters: scale.total_ascent_m ?? 0
        },
        speed: {
            averageKph: performance.avg_speed_kmh ?? 0,
            maxKph: performance.max_speed_kmh ?? 0
        },
        power: {
            averageWatts: power.avg_power_w ?? 0,
            maxWatts: power.max_power_w ?? 0,
            normalizedPowerWatts: power.normalized_power_w ?? null,
            intensityFactor: power.intensity_factor ?? null,
            variabilityIndex: power.variability_index ?? null
        },
        heartRate: {
            averageBpm: heartRate.avg_hr_bpm ?? 0,
            maxBpm: heartRate.max_hr_bpm ?? 0
        },
        cadence: {
            averageRpm: cadence.avg ?? 0,
            maxRpm: cadence.max ?? 0
        },
        load: {
            estimatedTss: metrics.load?.power_stress?.tss ?? null
        },
        energy: {
            ...fallbackEnergy,
            estimatedCaloriesKcal: scale.calories ?? fallbackEnergy.estimatedCaloriesKcal ?? null,
            mechanicalWorkKj: power.total_work_kj ?? fallbackEnergy.mechanicalWorkKj ?? null,
            method: scale.calories != null ? "fit" : (fallbackEnergy.method ?? null)
        }
    };
    const id = activity.activity_key ?? fallback.id;
    const name = activity.name ?? fallback.name ?? activity.file_name ?? id;
    const rawSession = {
        ...(fallback.rawSession ?? {}),
        activityId: id,
        createdAt: activity.start_time_local ?? fallback.startedAt ?? null,
        startedAt: activity.start_time_local ?? fallback.startedAt ?? null,
        source: activity.source ?? fallback.source ?? "fit-import",
        settings: {
            ...(fallback.rawSession?.settings ?? {}),
            ftp: detail?.settings?.ftp ?? fallback.rawSession?.settings?.ftp ?? null,
            restingHr: detail?.settings?.resting_hr ?? fallback.rawSession?.settings?.restingHr ?? null,
            maxHr: detail?.settings?.max_hr ?? fallback.rawSession?.settings?.maxHr ?? null,
            mass: detail?.settings?.mass_kg ?? fallback.rawSession?.settings?.mass ?? null
        },
        records,
        route,
        summary: { metrics: summaryMetrics },
        exportMetadata: {
            ...(fallback.rawSession?.exportMetadata ?? {}),
            activityName: name
        }
    };
    return {
        ...fallback,
        id,
        name,
        source: activity.source ?? fallback.source,
        sportType: activity.sport_type ?? fallback.sportType,
        subSport: activity.sub_sport ?? fallback.subSport,
        startedAt: activity.start_time_local ?? fallback.startedAt,
        elapsedSeconds: scale.duration_s ?? fallback.elapsedSeconds,
        distanceKm: scale.distance_km ?? fallback.distanceKm,
        ascentMeters: scale.total_ascent_m ?? fallback.ascentMeters,
        averagePower: power.avg_power_w ?? fallback.averagePower,
        normalizedPower: power.normalized_power_w ?? fallback.normalizedPower,
        averageHr: heartRate.avg_hr_bpm ?? fallback.averageHr,
        estimatedTss: metrics.load?.power_stress?.tss ?? fallback.estimatedTss,
        fitFilePath: activity.fit_path ?? fallback.fitFilePath,
        analysisReport,
        rawSession
    };
}

function buildRiderRecords(records) {
    let previousElevation = null;
    let ascentMeters = 0;
    return records.map((record) => {
        const elevationMeters = record.elevation_m ?? null;
        if (Number.isFinite(elevationMeters) && Number.isFinite(previousElevation)) {
            ascentMeters += Math.max(0, elevationMeters - previousElevation);
        }
        if (Number.isFinite(elevationMeters)) previousElevation = elevationMeters;
        return {
            elapsedSeconds: record.elapsed_seconds ?? 0,
            distanceKm: record.distance_km ?? 0,
            power: record.power_w ?? null,
            heartRate: record.heart_rate_bpm ?? null,
            cadence: record.cadence_rpm ?? null,
            speedKph: record.speed_kmh ?? null,
            elevationMeters,
            gradePercent: record.grade_percent ?? null,
            positionLat: record.latitude ?? null,
            positionLong: record.longitude ?? null,
            ascentMeters
        };
    });
}

function hasRouteGeometry(route) {
    const points = route?.mapGeometry?.length >= 2 ? route.mapGeometry : route?.points;
    return (points ?? []).filter((point) => {
        const latitude = point?.latitude ?? point?.lat;
        const longitude = point?.longitude ?? point?.lng;
        return Number.isFinite(latitude) && Number.isFinite(longitude);
    }).length >= 2;
}
