import { buildRideMetrics } from "../../domain/metrics/ride-metrics.js";
import { loadFitSdk } from "./fit-sdk-loader.js";

const SEMICIRCLES_TO_DEGREES = 180 / 2147483648;

export async function importFitActivity(arrayBuffer, {
    fileName = "Imported FIT Ride",
    settings = {}
} = {}) {
    const { Decoder, Stream } = await loadFitSdk();
    const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    const stream = createFitStream(Stream, bytes);
    const decoder = new Decoder(stream);

    if (typeof decoder.checkIntegrity === "function" && !decoder.checkIntegrity()) {
        throw new Error("FIT 文件校验失败。");
    }

    const result = decoder.read();
    if (Array.isArray(result?.errors) && result.errors.length > 0) {
        const message = result.errors.map((error) => error?.message ?? String(error)).join(" | ");
        throw new Error(`FIT 解析失败：${message}`);
    }

    return buildSessionFromFitMessages({
        messages: result?.messages ?? result,
        fileName,
        settings
    });
}

export function buildSessionFromFitMessages({
    messages = {},
    fileName = "Imported FIT Ride",
    settings = {}
} = {}) {
    const recordMessages = normalizeMessageList(messages.recordMesgs ?? messages.records ?? messages.recordMessages)
        .filter((message) => message && typeof message === "object")
        .sort(compareFitRecords);

    if (!recordMessages.length) {
        throw new Error("FIT 文件里没有 record 数据，无法分析。");
    }

    const activityName = normalizeActivityName({
        fileName,
        sessionMessage: normalizeMessageList(messages.sessionMesgs).at(0)
    });
    const startedAt = resolveStartDate(recordMessages, messages);
    const records = buildRecords(recordMessages, startedAt);
    const finalRecord = records.at(-1) ?? {};
    const metrics = buildRideMetrics({
        records,
        ftp: Number.isFinite(settings?.ftp) ? settings.ftp : null
    });
    const finishedAt = new Date(startedAt.getTime() + (Number(finalRecord.elapsedSeconds) || 0) * 1000);
    const route = buildRouteFromRecords({
        records,
        name: activityName
    });
    const session = {
        source: "fit-import",
        createdAt: new Date().toISOString(),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        route,
        settings: { ...settings },
        records,
        summary: { metrics },
        exportMetadata: {
            activityName,
            markVirtualActivity: false
        }
    };

    return {
        session,
        activity: buildActivityFromSession(session, activityName)
    };
}

function buildRecords(recordMessages, startedAt) {
    const baseTime = startedAt.getTime();
    const records = [];
    let fallbackElapsedSeconds = 0;
    let ascentMeters = 0;
    let previousAltitude = null;

    for (const message of recordMessages) {
        const timestamp = parseFitDate(message.timestamp);
        const elapsedSeconds = timestamp
            ? Math.max(0, Math.round((timestamp.getTime() - baseTime) / 1000))
            : fallbackElapsedSeconds;
        fallbackElapsedSeconds = elapsedSeconds + 1;

        const elevationMeters = firstFinite(message.enhancedAltitude, message.altitude);
        const directAscent = finiteOrNull(message.totalAscent);
        if (directAscent !== null) {
            ascentMeters = directAscent;
        } else if (elevationMeters !== null && previousAltitude !== null && elevationMeters > previousAltitude) {
            ascentMeters += elevationMeters - previousAltitude;
        }
        if (elevationMeters !== null) {
            previousAltitude = elevationMeters;
        }

        const record = {
            elapsedSeconds,
            elapsedLabel: formatElapsedLabel(elapsedSeconds),
            heartRate: finiteOrUndefined(message.heartRate),
            power: finiteOrUndefined(message.power),
            cadence: finiteOrUndefined(message.cadence),
            speedKph: scaleMpsToKph(firstFinite(message.enhancedSpeed, message.speed)),
            distanceKm: scaleMetersToKm(message.distance),
            elevationMeters: finiteOrUndefined(elevationMeters),
            ascentMeters,
            gradePercent: finiteOrUndefined(message.grade),
            positionLat: semicirclesToDegrees(message.positionLat),
            positionLong: semicirclesToDegrees(message.positionLong)
        };

        records.push(compactObject(record));
    }

    const totalDistanceKm = finiteOrNull(records.at(-1)?.distanceKm);
    return records.map((record) => ({
        ...record,
        routeProgress: totalDistanceKm && totalDistanceKm > 0 && Number.isFinite(record.distanceKm)
            ? Math.min(1, Math.max(0, record.distanceKm / totalDistanceKm))
            : 0
    }));
}

function buildRouteFromRecords({ records, name }) {
    const points = records
        .map((record) => ({
            lat: record.positionLat,
            lon: record.positionLong,
            elevationMeters: record.elevationMeters,
            distanceMeters: Number.isFinite(record.distanceKm) ? record.distanceKm * 1000 : null,
            gradePercent: record.gradePercent
        }))
        .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));
    const finalRecord = records.at(-1) ?? {};

    return {
        name,
        source: "fit-import",
        totalDistanceMeters: Number.isFinite(finalRecord.distanceKm) ? finalRecord.distanceKm * 1000 : 0,
        totalAscentMeters: Number.isFinite(finalRecord.ascentMeters) ? finalRecord.ascentMeters : 0,
        hasElevationData: records.some((record) => Number.isFinite(record.elevationMeters)),
        points,
        segments: []
    };
}

function buildActivityFromSession(session, name) {
    const metrics = session.summary?.metrics ?? {};
    return {
        id: null,
        name,
        source: "fit-import",
        sportType: "Ride",
        createdAt: session.createdAt,
        startedAt: session.startedAt,
        elapsedSeconds: metrics.ride?.elapsedSeconds ?? 0,
        distanceKm: metrics.ride?.distanceKm ?? 0,
        ascentMeters: metrics.ride?.ascentMeters ?? 0,
        averagePower: metrics.power?.averageWatts ?? 0,
        normalizedPower: metrics.power?.normalizedPowerWatts ?? 0,
        estimatedTss: metrics.load?.estimatedTss ?? 0,
        averageHr: metrics.heartRate?.averageBpm ?? 0,
        rawSession: session
    };
}

function resolveStartDate(recordMessages, messages) {
    const candidates = [
        recordMessages.at(0)?.timestamp,
        normalizeMessageList(messages.sessionMesgs).at(0)?.startTime,
        normalizeMessageList(messages.sessionMesgs).at(0)?.timestamp,
        normalizeMessageList(messages.activityMesgs).at(0)?.timestamp
    ];

    for (const candidate of candidates) {
        const date = parseFitDate(candidate);
        if (date) return date;
    }

    return new Date();
}

function compareFitRecords(left, right) {
    const leftDate = parseFitDate(left?.timestamp);
    const rightDate = parseFitDate(right?.timestamp);
    if (leftDate && rightDate) return leftDate.getTime() - rightDate.getTime();
    if (leftDate) return -1;
    if (rightDate) return 1;
    return 0;
}

function parseFitDate(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

function createFitStream(Stream, bytes) {
    if (Stream?.fromArrayBuffer) {
        return Stream.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    }
    if (Stream?.fromByteArray) {
        return Stream.fromByteArray([...bytes]);
    }
    return bytes;
}

function normalizeMessageList(value) {
    return Array.isArray(value) ? value : [];
}

function normalizeActivityName({ fileName, sessionMessage }) {
    const sessionName = String(sessionMessage?.sportProfileName ?? "").trim();
    if (sessionName) return sessionName;
    const baseName = String(fileName ?? "").split(/[\\/]/).pop()?.replace(/\.fit$/i, "").trim();
    return baseName || "Imported FIT Ride";
}

function semicirclesToDegrees(value) {
    return Number.isFinite(value) ? value * SEMICIRCLES_TO_DEGREES : undefined;
}

function scaleMpsToKph(value) {
    return Number.isFinite(value) ? value * 3.6 : undefined;
}

function scaleMetersToKm(value) {
    return Number.isFinite(value) ? value / 1000 : undefined;
}

function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
}

function firstFinite(...values) {
    for (const value of values) {
        if (Number.isFinite(value)) return value;
    }
    return null;
}

function finiteOrUndefined(value) {
    return Number.isFinite(value) ? value : undefined;
}

function compactObject(value) {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function formatElapsedLabel(seconds) {
    const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = Math.floor(safeSeconds / 60);
    const remainingSeconds = safeSeconds % 60;
    return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}
