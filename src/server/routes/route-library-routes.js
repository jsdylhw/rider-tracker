import express from "express";
import { sendAgentUnavailable } from "../agent-unavailable.js";

export function createRouteLibraryRoutes({ agentClient }) {
    const router = express.Router();
    const handlers = createRouteLibraryHandlers({ agentClient });

    router.get("/api/routes", handlers.list);
    router.post("/api/routes", handlers.save);
    router.get("/api/routes/:routeId", handlers.get);
    router.patch("/api/routes/:routeId", handlers.rename);
    router.delete("/api/routes/:routeId", handlers.remove);
    router.put("/api/routes/:routeId/progress", handlers.saveProgress);
    router.delete("/api/routes/:routeId/progress", handlers.clearProgress);

    return router;
}

export function createRouteLibraryHandlers({ agentClient }) {
    return {
        list: (req, res) => proxy(res, () => (
            agentClient.listSavedRoutes({ source: req.query?.source || "" })
        )),
        save: (req, res) => proxy(res, () => agentClient.saveRoute(req.body), 201),
        get: (req, res) => proxy(res, () => agentClient.getSavedRoute(req.params.routeId)),
        rename: (req, res) => proxy(res, () => (
            agentClient.renameSavedRoute(req.params.routeId, req.body?.name)
        )),
        remove: (req, res) => proxy(res, () => agentClient.deleteSavedRoute(req.params.routeId)),
        saveProgress: (req, res) => proxy(res, () => (
            agentClient.saveRouteProgress(req.params.routeId, req.body)
        )),
        clearProgress: (req, res) => proxy(res, () => (
            agentClient.clearRouteProgress(req.params.routeId)
        ))
    };
}

async function proxy(res, callback, successStatus = 200) {
    try {
        const result = await callback();
        return res.status(successStatus).json({ ok: true, ...result });
    } catch (error) {
        if (sendAgentUnavailable(res, error, { capability: "route_library" })) return;
        const status = Number(error?.statusCode) || 500;
        return res.status(status).json({ ok: false, error: error.message });
    }
}
