import { resolveRideMetrics } from "../../domain/metrics/ride-metrics.js";
import { getLoadedFitSdk, loadFitSdk } from "../fit/fit-sdk-loader.js";

const APP_PRODUCT_ID = 5101;
const APP_SOFTWARE_VERSION = 1;
const APP_SERIAL_NUMBER = 51010001;
const FIT_EPOCH_MS = 631065600000;

export async function exportSessionAsFit(session, exportMetadata, options = {}) {
    if (!session?.summary) {
        throw new Error("缺少 session.summary，无法导出 FIT。");
    }

    const { Encoder, Profile } = await loadFitSdk();
    return encodeFitWithSdk({ Encoder, Profile }, session, exportMetadata, options);
}

export function encodeFitSync(session, exportMetadata, options = {}) {
    if (!session?.summary) {
        return null;
    }

    const sdk = getLoadedFitSdk();
    if (!sdk) {
        return null;
    }

    return encodeFitWithSdk(sdk, session, exportMetadata, options);
}

function encodeFitWithSdk({ Encoder, Profile }, session, exportMetadata, options = {}) {
    const markVirtualActivity = options?.markVirtualActivity !== false;
    const summary = session.summary;
    const records = session.records ?? [];
    const encoder = new Encoder();
    const metadata = buildExportMetadata(exportMetadata ?? session.exportMetadata);
    const { startedAt, finishedAt } = resolveSessionTimestamps({ session, summary });
    const exportSummary = resolveFitExportSummary({
        summary: { ...summary, settings: session?.settings ?? summary?.settings },
        records,
        ftp: session?.settings?.ftp ?? options?.ftp ?? null
    });

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

    const settings = session?.settings ?? summary?.settings ?? {};
    if (Number.isFinite(settings.mass) || Number.isFinite(settings.restingHr) || Number.isFinite(settings.maxHr)) {
        const upMsg = {};
        if (Number.isFinite(settings.mass)) upMsg.weight = settings.mass;
        if (Number.isFinite(settings.restingHr)) upMsg.restingHeartRate = Math.round(settings.restingHr);
        if (Number.isFinite(settings.maxHr)) {
            upMsg.defaultMaxBikingHeartRate = Math.round(settings.maxHr);
            upMsg.defaultMaxHeartRate = Math.round(settings.maxHr);
        }
        encoder.onMesg(Profile.MesgNum.USER_PROFILE, upMsg);
    }

    encoder.onMesg(Profile.MesgNum.BIKE_PROFILE, {
        name: "Rider Tracker Virtual Bike",
        sport: "cycling"
    });

    if (Number.isFinite(settings.maxHr) && Number.isFinite(settings.restingHr)) {
        exportSummary.hrZones.forEach((zone) => {
            encoder.onMesg(Profile.MesgNum.HR_ZONE, {
                highBpm: zone.highBpm,
                name: zone.name
            });
        });
    }

    if (Number.isFinite(settings.ftp) || Number.isFinite(settings.maxHr)) {
        const ztMsg = {};
        if (Number.isFinite(settings.ftp)) ztMsg.functionalThresholdPower = Math.round(settings.ftp);
        if (Number.isFinite(settings.maxHr)) ztMsg.maxHeartRate = Math.round(settings.maxHr);
        encoder.onMesg(Profile.MesgNum.ZONES_TARGET, ztMsg);
    }

    if (Number.isFinite(settings.ftp)) {
        exportSummary.powerZones.forEach((zone) => {
            encoder.onMesg(Profile.MesgNum.POWER_ZONE, {
                highValue: zone.highValue,
                name: zone.name
            });
        });
    }

    encoder.onMesg(Profile.MesgNum.EVENT, {
        timestamp: startedAt,
        event: "timer",
        eventType: "start"
    });

    const exportedRecords = downsampleTo1Hz(records);

    exportedRecords.forEach((record) => {
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
        ...(Number.isFinite(exportSummary.normalizedPowerWatts) && exportSummary.normalizedPowerWatts > 0
            ? { normalizedPower: Math.round(exportSummary.normalizedPowerWatts) }
            : {}),
        ...(Number.isFinite(exportSummary.averageCadenceRpm)
            ? { avgCadence: Math.round(exportSummary.averageCadenceRpm) }
            : {}),
        ...(Number.isFinite(exportSummary.maxCadenceRpm)
            ? { maxCadence: Math.round(exportSummary.maxCadenceRpm) }
            : {}),
        ...(exportSummary.timeInPowerZone
            ? { timeInPowerZone: exportSummary.timeInPowerZone }
            : {}),
        ...(exportSummary.timeInHrZone
            ? { timeInHrZone: exportSummary.timeInHrZone }
            : {}),
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
        ...(Number.isFinite(exportSummary.normalizedPowerWatts) && exportSummary.normalizedPowerWatts > 0
            ? { normalizedPower: Math.round(exportSummary.normalizedPowerWatts) }
            : {}),
        ...(Number.isFinite(exportSummary.intensityFactor)
            ? { intensityFactor: exportSummary.intensityFactor }
            : {}),
        ...(Number.isFinite(exportSummary.trainingStressScore)
            ? { trainingStressScore: Math.round(exportSummary.trainingStressScore) }
            : {}),
        ...(Number.isFinite(exportSummary.thresholdPowerWatts)
            ? { thresholdPower: Math.round(exportSummary.thresholdPowerWatts) }
            : {}),
        ...(Number.isFinite(exportSummary.averageCadenceRpm)
            ? { avgCadence: Math.round(exportSummary.averageCadenceRpm) }
            : {}),
        ...(Number.isFinite(exportSummary.maxCadenceRpm)
            ? { maxCadence: Math.round(exportSummary.maxCadenceRpm) }
            : {}),
        ...(exportSummary.timeInPowerZone
            ? { timeInPowerZone: exportSummary.timeInPowerZone }
            : {}),
        ...(exportSummary.timeInHrZone
            ? { timeInHrZone: exportSummary.timeInHrZone }
            : {}),
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

export { downsampleTo1Hz };

export function resolveFitExportSummary({ summary = {}, records = [], ftp = null } = {}) {
    const metrics = resolveRideMetrics({ summary, records, ftp });

    const effectiveFtp = selectOptionalFiniteValue(
        ftp,
        summary?.settings?.ftp,
        summary?.exportMetadata?.ftp
    );

    const maxHr = selectOptionalFiniteValue(summary?.settings?.maxHr);
    const restingHr = selectOptionalFiniteValue(summary?.settings?.restingHr);

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
        normalizedPowerWatts: selectOptionalFiniteValue(
            metrics?.power?.normalizedPowerWatts
        ),
        intensityFactor: selectOptionalFiniteValue(
            metrics?.power?.intensityFactor
        ),
        trainingStressScore: selectOptionalFiniteValue(
            metrics?.load?.estimatedTss
        ),
        thresholdPowerWatts: selectOptionalFiniteValue(effectiveFtp),
        averageCadenceRpm: selectOptionalFiniteValue(
            metrics?.cadence?.averageRpm
        ),
        maxCadenceRpm: selectOptionalFiniteValue(
            metrics?.cadence?.maxRpm
        ),
        timeInPowerZone: Number.isFinite(effectiveFtp) && effectiveFtp > 0
            ? computePowerZoneTimes(records, effectiveFtp)
            : null,
        timeInHrZone: Number.isFinite(maxHr) && Number.isFinite(restingHr) && maxHr > restingHr
            ? computeHrZoneTimes(records, maxHr, restingHr)
            : null,
        hrZones: Number.isFinite(maxHr) && Number.isFinite(restingHr) && maxHr > restingHr
            ? buildHrZones(maxHr, restingHr)
            : [],
        powerZones: Number.isFinite(effectiveFtp) && effectiveFtp > 0
            ? buildPowerZones(effectiveFtp)
            : [],
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

function selectOptionalFiniteValue(...values) {
    for (const value of values) {
        if (Number.isFinite(value)) {
            return value;
        }
    }

    return null;
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

const POWER_ZONE_BOUNDARIES = [0.55, 0.75, 0.90, 1.05, 1.20, 1.50, Infinity];

function computePowerZoneTimes(records, ftp) {
    const zones = new Array(POWER_ZONE_BOUNDARIES.length).fill(0);
    for (let i = 1; i < records.length; i += 1) {
        const power = Number(records[i]?.power);
        if (!Number.isFinite(power)) continue;
        const dt = Math.max(0, (Number(records[i]?.elapsedSeconds) || 0) - (Number(records[i - 1]?.elapsedSeconds) || 0));
        const pct = power / ftp;
        let z = 0;
        while (z < POWER_ZONE_BOUNDARIES.length - 1 && pct > POWER_ZONE_BOUNDARIES[z]) z += 1;
        zones[z] += dt;
    }
    return zones.map((t) => Math.round(t * 1000) / 1000);
}

function computeHrZoneTimes(records, maxHr, restingHr) {
    const hrr = maxHr - restingHr;
    const ceilings = [0.60, 0.70, 0.80, 0.90, Infinity];
    const zones = new Array(ceilings.length).fill(0);
    for (let i = 1; i < records.length; i += 1) {
        const hr = Number(records[i]?.heartRate);
        if (!Number.isFinite(hr)) continue;
        const dt = Math.max(0, (Number(records[i]?.elapsedSeconds) || 0) - (Number(records[i - 1]?.elapsedSeconds) || 0));
        const hrPct = (hr - restingHr) / hrr;
        let z = 0;
        while (z < ceilings.length - 1 && hrPct > ceilings[z]) z += 1;
        zones[z] += dt;
    }
    return zones.map((t) => Math.round(t * 1000) / 1000);
}

function buildHrZones(maxHr, restingHr) {
    const hrr = maxHr - restingHr;
    const boundaries = [0.60, 0.70, 0.80, 0.90, Infinity];
    const names = ["Z1 Endurance", "Z2 Moderate", "Z3 Tempo", "Z4 Threshold", "Z5 Maximum"];
    return boundaries.map((pct, i) => ({
        highBpm: pct === Infinity ? maxHr : Math.round(restingHr + pct * hrr),
        name: names[i]
    }));
}

function buildPowerZones(ftp) {
    const names = ["Z1 ActiveRecovery", "Z2 Endurance", "Z3 Tempo", "Z4 Threshold", "Z5 VO2Max", "Z6 Anaerobic", "Z7 Neuromuscular"];
    // highValue = ceiling wattage; last zone has value 0 to indicate unbounded
    return POWER_ZONE_BOUNDARIES.map((pct, i) => ({
        highValue: pct === Infinity ? 0 : Math.round(ftp * pct),
        name: names[i]
    }));
}

function downsampleTo1Hz(records) {
    if (!records || records.length <= 1) {
        return records ?? [];
    }

    const firstElapsed = Number(records[0]?.elapsedSeconds) || 0;
    const lastElapsed = Number(records.at(-1)?.elapsedSeconds) || 0;
    const totalSeconds = lastElapsed - firstElapsed;

    if (totalSeconds <= 0) {
        return records;
    }

    // 如果记录密度 ≤ 1 条/秒，无需降采样
    if (records.length <= totalSeconds + 1) {
        return records;
    }

    // 按绝对秒边界分桶：(prevBoundary, boundary]，整秒点归当前桶
    // 如果首条是整秒（如 t=0），保留为独立 record；否则归入第一个 bucket
    const firstRecord = records[0];
    const lastRawRecord = records.at(-1);
    const startBucket = Math.max(1, Math.ceil(firstElapsed));
    const endBucket = Math.floor(lastElapsed);
    const result = [];
    let arrayCursor = 0;
    if (Number.isInteger(firstElapsed) && firstElapsed < startBucket) {
        result.push(firstRecord);
        arrayCursor = 1;
    }

    // 不足 1 秒但有多个 sub-second record 时聚合到 ceil(lastElapsed) 整秒
    const effectiveEndBucket = endBucket >= startBucket ? endBucket : Math.max(1, Math.ceil(lastElapsed));

    for (let sec = startBucket; sec <= effectiveEndBucket; sec += 1) {
        const bucketRecords = [];

        while (arrayCursor < records.length) {
            const elapsed = Number(records[arrayCursor]?.elapsedSeconds) || 0;
            if (elapsed <= sec) {
                bucketRecords.push(records[arrayCursor]);
                arrayCursor += 1;
            } else {
                break;
            }
        }

        if (bucketRecords.length > 0) {
            const representative = { ...bucketRecords.at(-1) };
            representative.elapsedSeconds = sec;
            representative.power = avgOf(bucketRecords, "power");
            representative.heartRate = avgOf(bucketRecords, "heartRate");
            representative.cadence = avgOf(bucketRecords, "cadence");
            representative.speedKph = avgOf(bucketRecords, "speedKph");
            representative.gradePercent = avgOf(bucketRecords, "gradePercent");
            result.push(representative);
        }
    }

    // 把原始末尾的累计字段合并到最后一条 bucket record
    if (result.length > 1 && lastRawRecord.elapsedSeconds >= effectiveEndBucket) {
        const lastBucket = result.at(-1);
        lastBucket.distanceKm = lastRawRecord.distanceKm;
        lastBucket.elevationMeters = lastRawRecord.elevationMeters;
        if (typeof lastRawRecord.positionLat === "number") lastBucket.positionLat = lastRawRecord.positionLat;
        if (typeof lastRawRecord.positionLong === "number") lastBucket.positionLong = lastRawRecord.positionLong;
        if (typeof lastRawRecord.ascentMeters === "number") lastBucket.ascentMeters = lastRawRecord.ascentMeters;
    }

    return result;
}

function avgOf(records, field) {
    let total = 0;
    let count = 0;
    for (const record of records) {
        const value = Number(record[field]);
        if (Number.isFinite(value)) {
            total += value;
            count += 1;
        }
    }
    return count > 0 ? total / count : records.at(-1)?.[field];
}
