import express from "express";

export function createNarrationRoutes({ agentClient }) {
    const router = express.Router();

    router.post("/api/route-narrations/prepare", async (req, res) => {
        try {
            const request = normalizeNarrationRequest(req.body);
            const result = await agentClient.prepareRouteNarration(request);
            return res.json({ ok: true, result });
        } catch (error) {
            const status = error instanceof RequestValidationError ? 400 : 502;
            return res.status(status).json({ ok: false, error: error.message });
        }
    });

    return router;
}

function normalizeNarrationRequest(body = {}) {
    const fingerprint = String(body.route_fingerprint || "").trim();
    const routeName = String(body.route_name || "").trim().slice(0, 200);
    const totalDistance = finiteInRange(body.total_distance_m, 1, 1_000_000, "total_distance_m");
    const duration = finiteInRange(body.estimated_duration_min, 1, 10_000, "estimated_duration_min");
    if (!/^route_[a-f0-9]{8}$/.test(fingerprint)) {
        throw new RequestValidationError("route_fingerprint 格式无效。");
    }
    if (!routeName) throw new RequestValidationError("route_name 不能为空。");
    if (!Array.isArray(body.samples) || body.samples.length < 2 || body.samples.length > 64) {
        throw new RequestValidationError("samples 必须包含 2-64 个路线采样点。");
    }
    return {
        route_fingerprint: fingerprint,
        route_name: routeName,
        total_distance_m: totalDistance,
        estimated_duration_min: duration,
        locale: body.locale === "en" ? "en" : "zh-CN",
        samples: body.samples.map((sample, index) => ({
            sample_id: `sample_${index + 1}`,
            route_distance_m: normalizeRouteDistance(sample?.route_distance_m, totalDistance),
            estimated_elapsed_s: optionalFinite(sample?.estimated_elapsed_s),
            latitude: finiteInRange(sample?.latitude, -90, 90, "latitude"),
            longitude: finiteInRange(sample?.longitude, -180, 180, "longitude"),
            elevation_m: optionalFinite(sample?.elevation_m),
            grade_percent: optionalFinite(sample?.grade_percent)
        }))
    };
}

function normalizeRouteDistance(value, totalDistance) {
    const number = Number(value);
    // Browser route geometry commonly carries sub-metre floating-point totals.
    // Accept a rounding-only overshoot, then clamp it to the authoritative total.
    if (!Number.isFinite(number) || number < 0 || number > totalDistance + 1) {
        throw new RequestValidationError("route_distance_m 格式无效。");
    }
    return Math.min(number, totalDistance);
}

function finiteInRange(value, minimum, maximum, field) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < minimum || number > maximum) {
        throw new RequestValidationError(`${field} 格式无效。`);
    }
    return number;
}

function optionalFinite(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

class RequestValidationError extends Error {}
