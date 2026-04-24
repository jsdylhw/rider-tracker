import { resolveRideMetrics } from "../../domain/metrics/ride-metrics.js";

const FIT_SDK_URLS = [
    "https://esm.sh/@garmin/fitsdk@21.178.0/es2022/fitsdk.mjs",
    "https://cdn.jsdelivr.net/npm/@garmin/fitsdk@21.178.0/es2022/fitsdk.mjs"
];
const APP_PRODUCT_ID = 5101;
const APP_SOFTWARE_VERSION = 1;
const APP_SERIAL_NUMBER = 51010001;
const FIT_EPOCH_MS = 631065600000;

let fitSdkPromise;

export async function exportSessionAsFit(session, exportMetadata, options = {}) {
    const { Encoder, Profile } = await loadFitSdk();

    if (!session?.summary) {
        throw new Error("缺少 session.summary，无法导出 FIT。");
    }

    const markVirtualActivity = options?.markVirtualActivity !== false;
    const summary = session.summary;
    const records = session.records ?? [];
    const encoder = new Encoder();
    const metadata = buildExportMetadata(exportMetadata ?? session.exportMetadata);
    const { startedAt, finishedAt } = resolveSessionTimestamps({ session, summary });
    const exportSummary = resolveFitExportSummary({ summary, records });

    encoder.onMesg(Profile.MesgNum.FILE_ID, {
        type: "activity",
        manufacturer: "development",
        product: APP_PRODUCT_ID,
        serialNumber: APP_SERIAL_NUMBER,
        timeCreated: startedAt
    });

    encoder.onMesg(Profile.MesgNum.DEVICE_INFO, {
        timestamp: startedAt,
        manufacturer: "development",
        product: APP_PRODUCT_ID,
        serialNumber: APP_SERIAL_NUMBER,
        softwareVersion: APP_SOFTWARE_VERSION,
        productName: metadata.productName
    });

    encoder.onMesg(Profile.MesgNum.FILE_CREATOR, {
        softwareVersion: APP_SOFTWARE_VERSION,
        hardwareVersion: 1
    });

    encoder.onMesg(Profile.MesgNum.EVENT, {
        timestamp: startedAt,
        event: "timer",
        eventType: "start"
    });

    records.forEach((record) => {
        const timestamp = new Date(startedAt.getTime() + (Number(record.elapsedSeconds) || 0) * 1000);
        const message = { timestamp };

        setFinite(message, "heartRate", record.heartRate);
        setFinite(message, "distance", Number.isFinite(record?.distanceKm) ? record.distanceKm * 1000 : null);
        setFinite(message, "speed", Number.isFinite(record?.speedKph) ? record.speedKph / 3.6 : null);
        setFinite(message, "altitude", record.elevationMeters);
        setFinite(message, "power", record.power);
        setFinite(message, "cadence", record.cadence);
        setFinite(message, "grade", record.gradePercent);

        if (typeof record.positionLat === "number" && typeof record.positionLong === "number") {
            message.positionLat = toSemicircles(record.positionLat);
            message.positionLong = toSemicircles(record.positionLong);
        }

        encoder.onMesg(Profile.MesgNum.RECORD, message);
    });

    encoder.onMesg(Profile.MesgNum.LAP, {
        timestamp: finishedAt,
        startTime: startedAt,
        totalElapsedTime: exportSummary.elapsedSeconds,
        totalTimerTime: exportSummary.elapsedSeconds,
        totalDistance: exportSummary.distanceMeters,
        totalAscent: Math.round(exportSummary.ascentMeters),
        avgSpeed: exportSummary.averageSpeedMps,
        maxSpeed: exportSummary.maxSpeedMps,
        avgHeartRate: exportSummary.averageHeartRate,
        maxHeartRate: exportSummary.maxHeartRate,
        avgPower: exportSummary.averagePower,
        maxPower: exportSummary.maxPower,
        avgGrade: exportSummary.grade.averagePercent,
        maxPosGrade: exportSummary.grade.maxPositivePercent,
        maxNegGrade: exportSummary.grade.maxNegativePercent
    });

    encoder.onMesg(Profile.MesgNum.SESSION, {
        timestamp: finishedAt,
        startTime: startedAt,
        totalElapsedTime: exportSummary.elapsedSeconds,
        totalTimerTime: exportSummary.elapsedSeconds,
        totalDistance: exportSummary.distanceMeters,
        totalAscent: Math.round(exportSummary.ascentMeters),
        avgSpeed: exportSummary.averageSpeedMps,
        maxSpeed: exportSummary.maxSpeedMps,
        avgHeartRate: exportSummary.averageHeartRate,
        maxHeartRate: exportSummary.maxHeartRate,
        avgPower: exportSummary.averagePower,
        maxPower: exportSummary.maxPower,
        totalDescent: Math.round(session.route?.totalDescentMeters ?? 0),
        avgGrade: exportSummary.grade.averagePercent,
        avgPosGrade: exportSummary.grade.averagePositivePercent,
        avgNegGrade: exportSummary.grade.averageNegativePercent,
        maxPosGrade: exportSummary.grade.maxPositivePercent,
        maxNegGrade: exportSummary.grade.maxNegativePercent,
        sportProfileName: metadata.profileName,
        sport: "cycling",
        ...(markVirtualActivity ? { subSport: "virtualActivity" } : {})
    });

    encoder.onMesg(Profile.MesgNum.EVENT, {
        timestamp: finishedAt,
        event: "timer",
        eventType: "stopAll"
    });

    encoder.onMesg(Profile.MesgNum.ACTIVITY, {
        timestamp: finishedAt,
        totalTimerTime: exportSummary.elapsedSeconds,
        numSessions: 1,
        type: "manual",
        event: "activity",
        eventType: "stop",
        localTimestamp: toFitLocalTimestamp(finishedAt)
    });

    return encoder.close();
}

export function exportSessionAsVirtualFit(session, exportMetadata) {
    return exportSessionAsFit(session, exportMetadata, { markVirtualActivity: true });
}

export function exportSessionAsPlainFit(session, exportMetadata) {
    return exportSessionAsFit(session, exportMetadata, { markVirtualActivity: false });
}

export function resolveFitExportSummary({ summary = {}, records = [] } = {}) {
    const metrics = resolveRideMetrics({ summary, records });

    return {
        elapsedSeconds: selectFiniteValue(
            metrics?.ride?.elapsedSeconds,
            records.at(-1)?.elapsedSeconds,
            0
        ),
        distanceMeters: selectFiniteValue(
            scaleKilometersToMeters(metrics?.ride?.distanceKm),
            scaleKilometersToMeters(records.at(-1)?.distanceKm),
            0
        ),
        ascentMeters: selectFiniteValue(
            metrics?.ride?.ascentMeters,
            records.at(-1)?.ascentMeters,
            0
        ),
        averageSpeedMps: selectFiniteValue(
            scaleKphToMps(metrics?.speed?.averageKph),
            deriveAverageSpeedMpsFromRecords(records),
            0
        ),
        maxSpeedMps: selectFiniteValue(
            scaleKphToMps(metrics?.speed?.maxKph),
            maxOf(records, (record) => scaleKphToMps(record?.speedKph)),
            0
        ),
        averageHeartRate: selectFiniteValue(
            metrics?.heartRate?.averageBpm,
            averageOf(records, (record) => record?.heartRate),
            0
        ),
        maxHeartRate: selectFiniteValue(
            metrics?.heartRate?.maxBpm,
            maxOf(records, (record) => record?.heartRate),
            0
        ),
        averagePower: selectFiniteValue(
            metrics?.power?.averageWatts,
            averageOf(records, (record) => record?.power),
            0
        ),
        maxPower: selectFiniteValue(
            metrics?.power?.maxWatts,
            maxOf(records, (record) => record?.power),
            0
        ),
        grade: {
            averagePercent: selectFiniteValue(
                metrics?.grade?.averagePercent,
                0
            ),
            averagePositivePercent: selectFiniteValue(
                metrics?.grade?.averagePositivePercent,
                0
            ),
            averageNegativePercent: selectFiniteValue(
                metrics?.grade?.averageNegativePercent,
                0
            ),
            maxPositivePercent: selectFiniteValue(
                metrics?.grade?.maxPositivePercent,
                0
            ),
            maxNegativePercent: selectFiniteValue(
                metrics?.grade?.maxNegativePercent,
                0
            )
        }
    };
}

async function loadFitSdk() {
    if (!fitSdkPromise) {
        fitSdkPromise = loadFirstAvailableFitSdk();
    }

    return fitSdkPromise;
}

async function loadFirstAvailableFitSdk() {
    const errors = [];
    for (const url of FIT_SDK_URLS) {
        try {
            return await import(url);
        } catch (err) {
            errors.push(err);
        }
    }
    const message = errors.map((err) => (err instanceof Error ? err.message : String(err))).filter(Boolean).join(" | ");
    throw new Error(`加载 FIT SDK 失败：${message || "未知错误"}`);
}

function toFitLocalTimestamp(date) {
    const timezoneOffsetSeconds = -date.getTimezoneOffset() * 60;
    return Math.floor((date.getTime() - FIT_EPOCH_MS) / 1000) + timezoneOffsetSeconds;
}

function resolveSessionTimestamps({ session, summary }) {
    const metrics = resolveRideMetrics({
        summary,
        records: session?.records ?? []
    });
    const elapsedMs = Math.max(0, Number(metrics?.ride?.elapsedSeconds ?? 0) * 1000);
    const startedAt = parseDate(session?.startedAt) ?? (elapsedMs > 0 ? new Date(Date.now() - elapsedMs) : new Date());
    const finishedAt = parseDate(session?.finishedAt)
        ?? parseDate(session?.createdAt)
        ?? new Date(startedAt.getTime() + elapsedMs);

    if (!Number.isFinite(finishedAt.getTime())) {
        return { startedAt, finishedAt: new Date(startedAt.getTime() + elapsedMs) };
    }

    if (elapsedMs > 0 && finishedAt.getTime() < startedAt.getTime()) {
        return { startedAt: new Date(finishedAt.getTime() - elapsedMs), finishedAt };
    }

    return { startedAt, finishedAt };
}

function parseDate(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

function setFinite(target, key, value) {
    if (Number.isFinite(value)) {
        target[key] = value;
    }
}

function selectFiniteValue(...values) {
    for (const value of values) {
        if (Number.isFinite(value)) {
            return value;
        }
    }

    return 0;
}

function maxOf(values, selector) {
    let maxValue = 0;
    for (const item of values) {
        const value = selector(item);
        if (Number.isFinite(value)) {
            maxValue = Math.max(maxValue, value);
        }
    }
    return maxValue;
}

function averageOf(values, selector) {
    let total = 0;
    let count = 0;

    for (const item of values) {
        const value = selector(item);
        if (Number.isFinite(value)) {
            total += value;
            count += 1;
        }
    }

    return count > 0 ? total / count : 0;
}

function deriveAverageSpeedMpsFromRecords(records) {
    const finalRecord = records.at(-1);
    const elapsedSeconds = Number(finalRecord?.elapsedSeconds);
    const distanceKm = Number(finalRecord?.distanceKm);

    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0 || !Number.isFinite(distanceKm)) {
        return 0;
    }

    return (distanceKm * 1000) / elapsedSeconds;
}

function scaleKphToMps(value) {
    return Number.isFinite(value) ? value / 3.6 : null;
}

function scaleKilometersToMeters(value) {
    return Number.isFinite(value) ? value * 1000 : null;
}

function buildExportMetadata(exportMetadata) {
    const repositoryUrl = normalizeText(exportMetadata?.repositoryUrl, "https://github.com/jsdylhw/rider-tracker");
    const activityName = normalizeText(exportMetadata?.activityName, "Rider Tracker Virtual Ride");
    const description = normalizeText(exportMetadata?.fitDescription, "Virtual ride generated by Rider Tracker.");

    return {
        activityName,
        repositoryUrl,
        fitDescription: `${description} Source: ${repositoryUrl}`,
        productName: buildProductName(activityName),
        profileName: buildProfileName(description, repositoryUrl)
    };
}

function normalizeText(value, fallback) {
    const text = String(value ?? "").trim();
    return text || fallback;
}

function buildProductName(activityName) {
    return activityName.slice(0, 80);
}

function buildProfileName(description, repositoryUrl) {
    const combined = `${description} | ${repositoryUrl}`;
    return combined.slice(0, 96);
}

function toSemicircles(degrees) {
    return Math.round((degrees * 2147483648) / 180);
}
