import express from "express";

export function createRouteLibraryRoutes({ routeLibraryStore }) {
    const router = express.Router();

    router.get("/api/routes", (req, res) => handle(res, () => ({
        routes: routeLibraryStore.listRoutes({ source: req.query.source || "" })
    })));
    router.post("/api/routes", (req, res) => handle(res, () => ({
        route: routeLibraryStore.saveRoute(req.body)
    }), 201));
    router.get("/api/routes/:routeId", (req, res) => handleRoute(res, () => (
        routeLibraryStore.getRoute(req.params.routeId)
    )));
    router.patch("/api/routes/:routeId", (req, res) => handleRoute(res, () => (
        routeLibraryStore.renameRoute(req.params.routeId, req.body?.name)
    )));
    router.delete("/api/routes/:routeId", (req, res) => handleRoute(res, () => (
        routeLibraryStore.deleteRoute(req.params.routeId)
    )));
    router.put("/api/routes/:routeId/progress", (req, res) => handleRoute(res, () => (
        routeLibraryStore.saveProgress(req.params.routeId, req.body)
    )));
    router.delete("/api/routes/:routeId/progress", (req, res) => handleRoute(res, () => (
        routeLibraryStore.clearProgress(req.params.routeId)
    )));

    return router;
}

function handleRoute(res, callback) {
    return handle(res, () => {
        const route = callback();
        if (!route) return res.status(404).json({ ok: false, error: "Saved route not found." });
        return { route };
    });
}

function handle(res, callback, successStatus = 200) {
    try {
        const result = callback();
        if (result?.headersSent || res.headersSent) return result;
        return res.status(successStatus).json({ ok: true, ...result });
    } catch (error) {
        const notFound = error.message === "Saved route not found.";
        return res.status(notFound ? 404 : 400).json({ ok: false, error: error.message });
    }
}
