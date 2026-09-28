// Frozen pre-migration projection oracle; never imported by production code.
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
