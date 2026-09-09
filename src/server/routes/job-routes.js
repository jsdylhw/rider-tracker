import express from "express";
import { randomUUID } from "node:crypto";

export function createJobRoutes({ agentClient }) {
    const router = express.Router();
    router.get("/api/jobs/capabilities", (_req, res) => proxy(res, () => agentClient.jobCapabilities()));
    router.post("/api/jobs", (req, res) => proxy(res, () => agentClient.submitJob(req.body), 202));
    router.get("/api/jobs/:jobId", (req, res) => proxy(res, () => agentClient.getJob(req.params.jobId)));
    router.post("/api/jobs/:jobId/cancel", (req, res) => proxy(res, () => agentClient.cancelJob(req.params.jobId)));
    router.get("/api/jobs/:jobId/report-rebuild", (req, res) => proxy(res, () => agentClient.reportRebuildJob(req.params.jobId)));
    return router;
}

async function proxy(res, operation, status = 200) {
    try {
        return res.status(status).json(await operation());
    } catch (error) {
        const statusCode = Number(error?.statusCode) || 503;
        return res.status(statusCode).json(error.envelope || {
            schema_version: "error.v1",
            request_id: randomUUID(),
            code: error.code || "agent_unavailable",
            message: "Task service is unavailable or the request was rejected.",
            retryable: statusCode >= 500,
            details: {}
        });
    }
}
