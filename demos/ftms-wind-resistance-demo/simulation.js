export const AIR_DENSITY_KG_PER_M3 = 1.226;

export function resolveLongitudinalWindMps({ riderHeadingDegrees, windFromDegrees, windSpeedMps }) {
    const heading = normalizeBearing(riderHeadingDegrees);
    const windFrom = normalizeBearing(windFromDegrees);
    const speed = clampNumber(windSpeedMps, 0, 32.767, 0);
    return speed * Math.cos(toRadians(windFrom - heading));
}

export function convertCdaToCw(cda) {
    return 0.5 * AIR_DENSITY_KG_PER_M3 * clampNumber(cda, 0, 4.16, 0.35);
}

export function buildSimulationPacket({ gradePercent, longitudinalWindMps, crr, cda }) {
    const normalized = {
        gradePercent: clampNumber(gradePercent, -100, 100, 0),
        longitudinalWindMps: clampNumber(longitudinalWindMps, -32.768, 32.767, 0),
        crr: clampNumber(crr, 0, 0.0255, 0.004),
        cda: clampNumber(cda, 0, 4.16, 0.35)
    };
    normalized.cw = Math.min(2.55, convertCdaToCw(normalized.cda));

    const buffer = new ArrayBuffer(7);
    const view = new DataView(buffer);
    view.setUint8(0, 0x11);
    view.setInt16(1, Math.round(normalized.longitudinalWindMps * 1000), true);
    view.setInt16(3, Math.round(normalized.gradePercent * 100), true);
    view.setUint8(5, Math.round(normalized.crr * 10000));
    view.setUint8(6, Math.round(normalized.cw * 100));

    return { packet: new Uint8Array(buffer), simulation: normalized };
}

export function formatPacket(packet) {
    return Array.from(packet, (value) => value.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

function normalizeBearing(value) {
    const numeric = Number(value);
    return ((Number.isFinite(numeric) ? numeric : 0) % 360 + 360) % 360;
}

function toRadians(value) {
    return value * Math.PI / 180;
}

function clampNumber(value, minimum, maximum, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.min(maximum, Math.max(minimum, numeric));
}
