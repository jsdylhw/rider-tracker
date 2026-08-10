import express from "express";

export function createRouteLibraryRoutes({ routeLibraryStore }) {
    const router = express.Router();

    router.get("/api/routes", (req, res) => {
        try {
            return res.json({ ok: true, routes: routeLibraryStore.listRoutes({ source: req.query.source || "gpx" }) });
        } catch (error) {
            return res.status(500).json({ ok: false, error: error.message });
        }
    });

    router.post("/api/routes/gpx", (req, res) => {
        try {
            const savedRoute = routeLibraryStore.saveGpxRoute({
                route: req.body?.route,
                originalGpxText: req.body?.originalGpxText
            });
            return res.status(savedRoute.created ? 201 : 200).json({ ok: true, route: savedRoute });
        } catch (error) {
            return res.status(400).json({ ok: false, error: error.message });
        }
    });

    router.get("/api/routes/:routeId", (req, res) => {
        try {
            const route = routeLibraryStore.getRoute(req.params.routeId);
            if (!route) return res.status(404).json({ ok: false, error: "Saved route not found." });
            return res.json({ ok: true, route });
        } catch (error) {
            return res.status(500).json({ ok: false, error: error.message });
        }
    });

    router.patch("/api/routes/:routeId/resume-distance", (req, res) => {
        try {
            const route = routeLibraryStore.updateResumeDistance(req.params.routeId, req.body?.resumeDistanceMeters);
            return res.json({ ok: true, route });
        } catch (error) {
            return res.status(error.message === "Saved route not found." ? 404 : 400).json({ ok: false, error: error.message });
        }
    });

    router.delete("/api/routes/:routeId", (req, res) => {
        try {
            return res.json({ ok: true, route: routeLibraryStore.deleteRoute(req.params.routeId) });
        } catch (error) {
            return res.status(error.message === "Saved route not found." ? 404 : 400).json({ ok: false, error: error.message });
        }
    });

    return router;
}
