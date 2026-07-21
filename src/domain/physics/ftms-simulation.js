export const DEFAULT_AIR_DENSITY_KG_PER_M3 = 1.226;
export const DEFAULT_ROLLING_RESISTANCE = 0.004;

export function convertCdaToFtmsCw(cda, airDensity = DEFAULT_AIR_DENSITY_KG_PER_M3) {
    const normalizedCda = clampNumber(cda, 0, 10, 0.35);
    const normalizedAirDensity = clampNumber(airDensity, 0, 2, DEFAULT_AIR_DENSITY_KG_PER_M3);
    return 0.5 * normalizedAirDensity * normalizedCda;
}

export function normalizeFtmsSimulationConfig({
    gradePercent,
    windSpeedMps = 0,
    crr = DEFAULT_ROLLING_RESISTANCE,
    cda = 0.35
} = {}) {
    return {
        gradePercent: clampNumber(gradePercent, -100, 100, 0),
        windSpeedMps: clampNumber(windSpeedMps, -32.768, 32.767, 0),
        crr: clampNumber(crr, 0, 0.0255, DEFAULT_ROLLING_RESISTANCE),
        cda: clampNumber(cda, 0, 4.16, 0.35),
        cw: clampNumber(convertCdaToFtmsCw(cda), 0, 2.55, convertCdaToFtmsCw(0.35))
    };
}

export function buildFtmsIndoorBikeSimulationPacket(config) {
    const simulation = normalizeFtmsSimulationConfig(config);
    const buffer = new ArrayBuffer(7);
    const view = new DataView(buffer);

    view.setUint8(0, 0x11);
    view.setInt16(1, Math.round(simulation.windSpeedMps * 1000), true);
    view.setInt16(3, Math.round(simulation.gradePercent * 100), true);
    view.setUint8(5, Math.round(simulation.crr * 10000));
    view.setUint8(6, Math.round(simulation.cw * 100));

    return {
        packet: new Uint8Array(buffer),
        simulation
    };
}

function clampNumber(value, minimum, maximum, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.min(maximum, Math.max(minimum, numeric));
}
