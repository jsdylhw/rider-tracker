const GRAVITY = 9.80665;
const AIR_DENSITY = 1.226;
const DRIVETRAIN_LOSS = 0.03;

export function resolveSpeedTarget({ power, gradePercent, mass, crr, cda, windSpeed }) {
    const effectivePower = Math.max(0, power) * (1 - DRIVETRAIN_LOSS);
    const slopeRatio = gradePercent / 100;
    const cosBeta = 1 / Math.sqrt(slopeRatio * slopeRatio + 1);
    const sinBeta = slopeRatio * cosBeta;

    let low = 0;
    let high = 35;

    for (let index = 0; index < 60; index += 1) {
        const mid = (low + high) / 2;
        const resistivePower = calculateResistivePower({
            speed: mid,
            mass,
            crr,
            cda,
            windSpeed,
            cosBeta,
            sinBeta
        });

        if (resistivePower > effectivePower) {
            high = mid;
        } else {
            low = mid;
        }
    }

    return (low + high) / 2;
}

export function simulateStep({
    speed,
    distanceMeters,
    elevationMeters,
    ascentMeters,
    power,
    heartRate,
    gradePercent,
    elapsedSeconds,
    settings,
    durationSeconds,
    dt
}) {
    const targetSpeed = resolveSpeedTarget({
        power,
        gradePercent,
        mass: settings.mass,
        crr: settings.crr,
        cda: settings.cda,
        windSpeed: settings.windSpeed
    });

    const responseFactor = Math.min(1, dt / 5);
    const nextSpeed = Math.max(0, speed + (targetSpeed - speed) * responseFactor);
    const nextDistanceMeters = distanceMeters + nextSpeed * dt;
    const slopeRatio = gradePercent / 100;
    const elevationDelta = nextSpeed * dt * slopeRatio;
    const nextElevationMeters = elevationMeters + elevationDelta;
    const nextAscentMeters = ascentMeters + Math.max(0, elevationDelta);
    const nextHeartRate = updateHeartRate({
        currentHeartRate: heartRate,
        power,
        elapsedSeconds,
        durationSeconds,
        restingHr: settings.restingHr,
        maxHr: settings.maxHr,
        dt
    });

    return {
        speed: nextSpeed,
        distanceMeters: nextDistanceMeters,
        elevationMeters: nextElevationMeters,
        ascentMeters: nextAscentMeters,
        heartRate: nextHeartRate
    };
}

function calculateResistivePower({ speed, mass, crr, cda, windSpeed, cosBeta, sinBeta }) {
    const gravityForce = mass * GRAVITY * sinBeta;
    const rollingForce = mass * GRAVITY * crr * cosBeta;
    const relativeWind = speed + windSpeed;
    const airForce = 0.5 * AIR_DENSITY * cda * relativeWind * relativeWind;
    const totalForce = gravityForce + rollingForce + airForce;
    return Math.max(0, totalForce * speed);
}

function updateHeartRate({
    currentHeartRate,
    power,
    elapsedSeconds,
    durationSeconds,
    restingHr,
    maxHr,
    dt
}) {
    const fatigueRatio = durationSeconds > 0 ? elapsedSeconds / durationSeconds : 0;
    const hrTarget = Math.min(
        maxHr,
        restingHr + power * 0.32 + 18 * fatigueRatio
    );

    return currentHeartRate + (hrTarget - currentHeartRate) * Math.min(1, dt / 18);
}
