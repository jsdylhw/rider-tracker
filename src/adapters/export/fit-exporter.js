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
    const maxSpeed = maxOf(records, (record) => (Number.isFinite(record?.speedKph) ? record.speedKph / 3.6 : null));
    const maxHeartRate = maxOf(records, (record) => (Number.isFinite(record?.heartRate) ? record.heartRate : null));
    const maxPower = maxOf(records, (record) => (Number.isFinite(record?.power) ? record.power : null));
    const gradeStats = summarizeGrades(records);

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
        totalElapsedTime: summary.elapsedSeconds,
        totalTimerTime: summary.elapsedSeconds,
        totalDistance: summary.distanceKm * 1000,
        totalAscent: Math.round(summary.ascentMeters),
        avgSpeed: summary.averageSpeedKph / 3.6,
        maxSpeed,
        avgHeartRate: summary.averageHeartRate,
        maxHeartRate,
        avgPower: summary.averagePower,
        maxPower,
        avgGrade: gradeStats.avgGrade,
        maxPosGrade: gradeStats.maxPosGrade,
        maxNegGrade: gradeStats.maxNegGrade
    });

    encoder.onMesg(Profile.MesgNum.SESSION, {
        timestamp: finishedAt,
        startTime: startedAt,
        totalElapsedTime: summary.elapsedSeconds,
        totalTimerTime: summary.elapsedSeconds,
        totalDistance: summary.distanceKm * 1000,
        totalAscent: Math.round(summary.ascentMeters),
        avgSpeed: summary.averageSpeedKph / 3.6,
        maxSpeed,
        avgHeartRate: summary.averageHeartRate,
        maxHeartRate,
        avgPower: summary.averagePower,
        maxPower,
        totalDescent: Math.round(session.route?.totalDescentMeters ?? 0),
        avgGrade: gradeStats.avgGrade,
        avgPosGrade: gradeStats.avgPosGrade,
        avgNegGrade: gradeStats.avgNegGrade,
        maxPosGrade: gradeStats.maxPosGrade,
        maxNegGrade: gradeStats.maxNegGrade,
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
        totalTimerTime: summary.elapsedSeconds,
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
    const elapsedMs = Math.max(0, Number(summary?.elapsedSeconds ?? 0) * 1000);
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

function summarizeGrades(records) {
    if (records.length === 0) {
        return {
            avgGrade: 0,
            avgPosGrade: 0,
            avgNegGrade: 0,
            maxPosGrade: 0,
            maxNegGrade: 0
        };
    }

    const gradeValues = records.map((record) => Number(record.gradePercent) || 0);
    const positiveGrades = gradeValues.filter((grade) => grade > 0);
    const negativeGrades = gradeValues.filter((grade) => grade < 0);

    return {
        avgGrade: average(gradeValues),
        avgPosGrade: average(positiveGrades),
        avgNegGrade: average(negativeGrades),
        maxPosGrade: positiveGrades.length > 0 ? Math.max(...positiveGrades) : 0,
        maxNegGrade: negativeGrades.length > 0 ? Math.min(...negativeGrades) : 0
    };
}

function average(values) {
    if (values.length === 0) {
        return 0;
    }

    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function toSemicircles(degrees) {
    return Math.round((degrees * 2147483648) / 180);
}
