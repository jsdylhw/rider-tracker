import express from "express";

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function createAgentRoutes({ agentClient }) {
    const router = express.Router();

    router.get("/api/agent/health", async (_req, res) => {
        try {
            const result = await agentClient.health();
            return res.json({ ok: true, result });
        } catch (error) {
            return res.status(502).json({ ok: false, error: error.message });
        }
    });

    router.post("/api/agent/chat", async (req, res) => {
        try {
            const request = normalizeChatRequest(req.body);
            const result = await agentClient.chat(request);
            return res.json({ ok: true, result });
        } catch (error) {
            return res.status(resolveStatus(error)).json({ ok: false, error: error.message });
        }
    });

    router.post("/api/agent/route-plans/select", async (req, res) => {
        try {
            const request = normalizeSelectionRequest(req.body);
            const result = await agentClient.selectRouteCandidate(request);
            return res.json({ ok: true, result });
        } catch (error) {
            return res.status(resolveStatus(error)).json({ ok: false, error: error.message });
        }
    });

    router.post("/api/agent/route-plans/command", async (req, res) => {
        try {
            const request = normalizeCommandRequest(req.body);
            const result = await agentClient.routePlanCommand(request);
            return res.json({ ok: true, result });
        } catch (error) {
            return res.status(resolveStatus(error)).json({ ok: false, error: error.message });
        }
    });

    return router;
}

function normalizeChatRequest(body = {}) {
    const sessionId = normalizeId(body.session_id, "session_id");
    const requestId = normalizeId(body.request_id, "request_id");
    const message = String(body.message || "").trim();
    if (!message || message.length > 20_000) {
        throw new RequestValidationError("message 必须是 1-20000 字符的文本。");
    }
    const routeOptions = normalizeRouteOptions(body.route_options);
    return {
        session_id: sessionId,
        request_id: requestId,
        message,
        ...(routeOptions ? { route_options: routeOptions } : {})
    };
}

function normalizeRouteOptions(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new RequestValidationError("route_options 格式无效。");
    }
    const result = {};
    if (value.include_elevation !== undefined) {
        if (typeof value.include_elevation !== "boolean") {
            throw new RequestValidationError("route_options.include_elevation 必须是布尔值。");
        }
        result.include_elevation = value.include_elevation;
    }
    return result;
}

function normalizeSelectionRequest(body = {}) {
    const sessionId = normalizeId(body.session_id, "session_id");
    const requestId = normalizeId(body.request_id, "request_id");
    const planId = normalizeText(body.plan_id, "plan_id");
    const candidateId = normalizeText(body.candidate_id, "candidate_id");
    const expectedRevision = normalizeRevision(body.expected_revision);
    return {
        session_id: sessionId,
        request_id: requestId,
        plan_id: planId,
        candidate_id: candidateId,
        expected_revision: expectedRevision
    };
}

function normalizeCommandRequest(body = {}) {
    const allowed = new Set(["get", "select", "confirm", "reverse", "undo", "explore_segments", "compose_segments"]);
    const operation = String(body.operation || "").trim();
    if (!allowed.has(operation)) throw new RequestValidationError("不支持的路线操作。");
    const request = {
        session_id: normalizeId(body.session_id, "session_id"),
        request_id: normalizeId(body.request_id, "request_id"),
        operation,
    };
    if (body.plan_id) request.plan_id = normalizeText(body.plan_id, "plan_id");
    if (operation !== "get") request.expected_revision = normalizeRevision(body.expected_revision);
    if (body.candidate_id) request.candidate_id = normalizeText(body.candidate_id, "candidate_id");
    if (body.candidate_name) request.candidate_name = String(body.candidate_name).trim().slice(0, 200);
    if (body.target_distance_km !== undefined && body.target_distance_km !== null) {
        const distance = Number(body.target_distance_km);
        if (!Number.isFinite(distance) || distance <= 0) throw new RequestValidationError("target_distance_km 格式无效。");
        request.target_distance_km = distance;
    }
    if (operation === "compose_segments") {
        request.segments = normalizeSegments(body.segments);
    }
    if (operation === "explore_segments") {
        request.corridor_km = clampNumber(body.corridor_km, 0.1, 20, 5);
        request.max_segments = Math.round(clampNumber(body.max_segments, 1, 20, 12));
    }
    return request;
}

function normalizeRevision(value) {
    const revision = Number(value);
    if (!Number.isInteger(revision) || revision < 1) {
        throw new RequestValidationError("expected_revision 格式无效。");
    }
    return revision;
}

function normalizeSegments(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
        throw new RequestValidationError("segments 必须包含 1-3 个路段。");
    }
    return value.map((item) => {
        const segmentId = Number(item?.segment_id);
        const direction = ["auto", "forward", "reverse"].includes(item?.direction) ? item.direction : "auto";
        if (!Number.isInteger(segmentId) || segmentId <= 0) {
            throw new RequestValidationError("segment_id 格式无效。");
        }
        return { segment_id: segmentId, direction };
    });
}

function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function normalizeId(value, field) {
    const text = String(value || "").trim();
    if (!SESSION_ID_PATTERN.test(text)) {
        throw new RequestValidationError(`${field} 格式无效。`);
    }
    return text;
}

function normalizeText(value, field) {
    const text = String(value || "").trim();
    if (!text || text.length > 128) {
        throw new RequestValidationError(`${field} 格式无效。`);
    }
    return text;
}

function resolveStatus(error) {
    if (error instanceof RequestValidationError) return 400;
    return Number.isInteger(error?.statusCode) ? error.statusCode : 502;
}

class RequestValidationError extends Error {}
