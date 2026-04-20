const FIT_SDK_URL = "https://esm.sh/@garmin/fitsdk@21.178.0/es2022/fitsdk.mjs";
const APP_PRODUCT_ID = 5101;
const APP_SOFTWARE_VERSION = 1;
const APP_SERIAL_NUMBER = 51010001;
const FIT_EPOCH_MS = 631065600000;

let fitSdkPromise;

export async function exportSessionAsFit(session, exportMetadata) {
    const { Encoder, Profile } = await loadFitSdk();

    const encoder = new Encoder();
    const records = session.records ?? [];
    const summary = session.summary;
    const metadata = buildExportMetadata(exportMetadata ?? session.exportMetadata);
    const finishedAt = new Date(session.createdAt);
    const startedAt = new Date(finishedAt.getTime() - summary.elapsedSeconds * 1000);
    const maxSpeed = Math.max(...records.map((record) => record.speedKph / 3.6), 0);
    const maxHeartRate = Math.max(...records.map((record) => record.heartRate), 0);
    const maxPower = Math.max(...records.map((record) => record.power), 0);
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
        const message = {
            timestamp: new Date(startedAt.getTime() + record.elapsedSeconds * 1000),
            heartRate: record.heartRate,
            distance: record.distanceKm * 1000,
            speed: record.speedKph / 3.6,
            altitude: record.elevationMeters,
            power: record.power,
            grade: record.gradePercent
        };

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
        // subSport: "virtualActivity"
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

async function loadFitSdk() {
    if (!fitSdkPromise) {
        fitSdkPromise = import(FIT_SDK_URL);
    }

    return fitSdkPromise;
}

function toFitLocalTimestamp(date) {
    const timezoneOffsetSeconds = -date.getTimezoneOffset() * 60;
    return Math.floor((date.getTime() - FIT_EPOCH_MS) / 1000) + timezoneOffsetSeconds;
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
