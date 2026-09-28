import express from "express";
import { createAgentUnavailableError, sendAgentUnavailable } from "../agent-unavailable.js";
import { DEFAULT_ACTIVITY_LIBRARY_TIMEOUT_MS } from "../personal-fit-agent-client.js";

export function createActivityRoutes({ agentClient, upload }) {
    const router = express.Router();
    const libraryHandlers = createActivityLibraryHandlers({ agentClient });

    router.get("/api/activities", libraryHandlers.list);
    router.post("/api/activities/rider-session", createRiderSessionArchiveHandler({ agentClient }));

    router.get("/api/activities/:activityId", libraryHandlers.get);
    router.post("/api/activities/fit-import", uploadHandler("/api/activities/fit-import"));
    router.post("/api/activities/fit-beacon", uploadHandler("/api/activities/fit-beacon"));
    router.post("/api/activities/:activityId/fit", uploadHandler("/api/activities/:activityId/fit"));

    function uploadHandler(pathname) {
        return (req, res) => {
            upload.single("file")(req, res, async (error) => {
                if (error) return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ ok: false, error: error.message });
                try {
                    const target = pathname.includes(":activityId")
                        ? `/api/activities/${encodeURIComponent(req.params.activityId)}/fit` : pathname;
                    return res.json(await agentClient.uploadFit(target, req.file, req.body));
                } catch (err) {
                    return sendActivityWriteError(res, err, { fallbackStatus: 500 });
                }
            });
        };
    }

    router.patch("/api/activities/:activityId", libraryHandlers.rename);
    router.delete("/api/activities/:activityId", libraryHandlers.remove);

    return router;
}

export function createRiderSessionArchiveHandler({ agentClient }) {
    return async (req, res) => {
        try {
            const result = await agentClient.archiveRiderSession({
                session: req.body?.session,
                name: req.body?.name,
                sportType: req.body?.sportType
            });
            return res.status(200).json({ ok: true, ...result });
        } catch (error) {
            if (sendAgentUnavailable(res, error, { capability: "activity_archive" })) return;
            return res.status(Number(error?.statusCode) || 500).json({
                ok: false,
                error: error.message,
                ...(error?.code ? { code: error.code } : {}),
                ...(typeof error?.retryable === "boolean" ? { retryable: error.retryable } : {})
            });
        }
    };
}

export function sendActivityWriteError(res, error, { fallbackStatus }) {
    if (sendAgentUnavailable(res, error, { capability: "fit_ingestion" })) return res;
    return res.status(Number(error?.statusCode) || fallbackStatus).json({
        ok: false,
        error: error.message,
        ...(error?.code ? { code: error.code } : {}),
        ...(typeof error?.retryable === "boolean" ? { retryable: error.retryable } : {})
    });
}

export function createActivityLibraryHandlers({
    agentClient,
    timeoutMs = DEFAULT_ACTIVITY_LIBRARY_TIMEOUT_MS,
    now = Date.now
}) {
    return {
        list: (req, res) => proxyActivityLibrary(res, () => agentClient.listActivities({
            limit: req.query?.limit,
            offset: req.query?.offset,
            sportType: req.query?.sportType || "",
            source: req.query?.source || ""
        })),
        get: (req, res) => proxyActivityLibrary(res, async () => {
            const deadline = now() + timeoutMs;
            const result = await agentClient.getActivity(req.params.activityId, {
                requestTimeoutMs: remainingActivityLibraryTime(deadline, now)
            });
            const storedActivity = result?.activity ?? null;
            const activity = storedActivity?.fitFilePath
                ? await agentClient.activityDetail(req.params.activityId, {
                    requestTimeoutMs: remainingActivityLibraryTime(deadline, now), view: "rider"
                })
                : storedActivity;
            return { activity };
        }),
        rename: (req, res) => proxyActivityLibrary(res, () => (
            agentClient.renameActivity(req.params.activityId, req.body?.name)
        )),
        remove: (req, res) => proxyActivityLibrary(res, () => (
            agentClient.deleteActivity(req.params.activityId)
        ))
    };
}

function remainingActivityLibraryTime(deadline, now) {
    const remainingMs = Math.floor(deadline - now());
    if (remainingMs <= 0) {
        throw createAgentUnavailableError("Training Agent 未能在活动详情读取时限内响应。");
    }
    return remainingMs;
}

async function proxyActivityLibrary(res, callback) {
    try {
        const result = await callback();
        return res.status(200).json({ ok: true, ...result });
    } catch (error) {
        if (sendAgentUnavailable(res, error, { capability: "activity_library" })) return;
        return res.status(Number(error?.statusCode) || 500).json({
            ok: false,
            error: error.message,
            ...(error?.code ? { code: error.code } : {}),
            ...(typeof error?.retryable === "boolean" ? { retryable: error.retryable } : {})
        });
    }
}
