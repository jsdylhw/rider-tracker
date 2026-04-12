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
    const mass = settings.mass;
    const crr = settings.crr;
    const cda = settings.cda;
    const windSpeed = settings.windSpeed;
    const effectivePower = Math.max(0, power) * (1 - DRIVETRAIN_LOSS);

    // 计算当前速度下的各种阻力
    const slopeRatio = gradePercent / 100;
    const cosBeta = 1 / Math.sqrt(slopeRatio * slopeRatio + 1);
    const sinBeta = slopeRatio * cosBeta;

    const gravityForce = mass * GRAVITY * sinBeta;
    const rollingForce = mass * GRAVITY * crr * cosBeta;
    const relativeWind = speed + windSpeed;
    // 只有当相对风速为正（迎风或自己速度快）时才有空气阻力
    const airForce = relativeWind > 0 ? 0.5 * AIR_DENSITY * cda * relativeWind * relativeWind : 0;
    
    const totalResistiveForce = gravityForce + rollingForce + airForce;

    // F = m * a => a = F / m
    // 推力 F_drive = Power / v (注意当速度非常低时，推力会无限大，因此要做限制)
    // 为避免除以0，我们假设一个极小的最小速度，或者如果速度接近0且有踩踏功率，给予一个启动加速度
    let driveForce = 0;
    
    if (speed > 1.0) {
        // 当速度大于 1m/s (3.6km/h) 时，使用标准的 P = F*v 公式
        driveForce = effectivePower / speed;
    } else if (effectivePower > 0) {
        // 当速度非常低时，如果还用 P/v，推力会极大（比如 v=0.01 时推力大到飞起）
        // 这样会导致极大的加速度，结果就是高功率在一开始的 1 秒内直接“瞬移”甚至超速，然后因为超出空气阻力上限又掉速
        // 所以我们限制一个启动期的最大推力，或者假定一个最小参考速度进行推力封顶
        driveForce = effectivePower / 1.0; 
    }

    const netForce = driveForce - totalResistiveForce;
    const acceleration = netForce / mass;

    // v = v0 + a * t
    let nextSpeed = speed + acceleration * dt;
    
    // 如果没有踩踏且受到极大的负向力，速度最多降到0，不能变负
    if (nextSpeed < 0) {
        nextSpeed = 0;
    }

    // 限制最大速度 (比如下坡时不踩踏也可能会无限加速，这里做一个合理的极速限制 120km/h = 33.3 m/s)
    if (nextSpeed > 33.3) {
        nextSpeed = 33.3;
    }

    const nextDistanceMeters = distanceMeters + nextSpeed * dt;
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
