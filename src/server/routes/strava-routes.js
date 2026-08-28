import express from "express";
import crypto from "node:crypto";
import { buildStravaLoginPage } from "../pages/strava-login-page.js";
import { sendOAuthResultPage } from "../pages/oauth-result-page.js";
import { normalizeText, normalizeUserId, parseBoolean } from "../shared/http-utils.js";
import { sendAgentUnavailable } from "../agent-unavailable.js";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export function createOAuthStateStore({
    ttlMs = OAUTH_STATE_TTL_MS,
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout
} = {}) {
    const states = new Map();
    function deleteState(state) {
        const meta = states.get(state);
        if (!meta) return false;
        if (meta.timer) clearTimeoutFn(meta.timer);
        states.delete(state);
        return true;
    }
    function sweepExpired() {
        const currentTime = now();
        for (const [state, meta] of states.entries()) {
            if (meta.expiresAtMs <= currentTime) deleteState(state);
        }
    }
    function set(state, userId) {
        deleteState(state);
        const expiresAtMs = now() + ttlMs;
        const timer = setTimeoutFn(() => states.delete(state), ttlMs);
        if (typeof timer?.unref === "function") timer.unref();
        states.set(state, { userId, expiresAtMs, timer });
        return states.get(state);
    }
    function consume(state) {
        sweepExpired();
        const meta = states.get(state);
        if (!meta) return null;
        deleteState(state);
        return meta;
    }
    function has(state) {
        sweepExpired();
        return states.has(state);
    }
    function size() {
        sweepExpired();
        return states.size;
    }
    return { set, consume, delete: deleteState, sweepExpired, has, size };
}

export function createStravaRoutes({ agentClient, scopes, redirectUri, frontendRedirectUrl }) {
    const router = express.Router();
    const oauthStates = createOAuthStateStore();

    async function getConfig() {
        return agentClient.stravaConfig();
    }

    async function ensureConfigured(res) {
        const config = await getConfig();
        if (config.configured) return config;
        res.status(409).json({
            ok: false,
            configured: false,
            loginUrl: "/strava/login",
            error: "Missing Strava credentials. Configure the strava section in config.yaml."
        });
        return null;
    }

    router.get("/api/strava/config", async (_req, res) => {
        try {
            const config = await getConfig();
            res.json({ ok: true, ...config, loginUrl: "/strava/login", redirectUri, scopes });
        } catch (error) {
            if (sendAgentUnavailable(res, error, { capability: "strava" })) return;
            res.status(502).json({ ok: false, error: error.message });
        }
    });

    router.post("/api/strava/config", (_req, res) => {
        res.status(409).json({
            ok: false,
            error: "Strava credentials have one owner. Update config.yaml and restart Rider."
        });
    });

    router.get("/strava/login", async (req, res) => {
        const userId = normalizeUserId(req.query.userId);
        try {
            const config = await getConfig();
            res.type("html").send(buildStravaLoginPage({
                userId,
                configured: config.configured,
                hasEnvCredentials: config.configured,
                redirectUri,
                scopes,
                configPath: config.token_store || "config.yaml"
            }));
        } catch (error) {
            res.status(502).send(error.message);
        }
    });

    router.get("/api/strava/auth/start", async (req, res) => {
        try {
            if (!await ensureConfigured(res)) return;
            const userId = normalizeUserId(req.query.userId);
            const state = `${userId}:${crypto.randomBytes(12).toString("hex")}`;
            oauthStates.sweepExpired();
            oauthStates.set(state, userId);
            const result = await agentClient.stravaAuthorizeUrl({
                redirect_uri: redirectUri,
                scope: scopes,
                state
            });
            res.json({ ok: true, authUrl: result.auth_url, state, userId });
        } catch (error) {
            if (sendAgentUnavailable(res, error, { capability: "strava" })) return;
            res.status(502).json({ ok: false, error: error.message });
        }
    });

    router.get("/api/strava/auth/callback", async (req, res) => {
        const { code, state, error, scope } = req.query;
        if (error) {
            if (state) oauthStates.delete(String(state));
            return sendOAuthResultPage(res, {
                ok: false,
                title: "Strava authorization failed",
                message: `Strava returned: ${String(error)}`
            });
        }
        const stateMeta = code && state ? oauthStates.consume(String(state)) : null;
        if (!code || !state || !stateMeta) {
            return sendOAuthResultPage(res, {
                ok: false,
                title: "Strava authorization expired",
                message: "Missing code/state, or the authorization state has expired. Please try connecting again."
            });
        }
        try {
            await agentClient.stravaExchangeCode({ code: String(code) });
            if (frontendRedirectUrl) {
                const redirectUrl = new URL(frontendRedirectUrl);
                redirectUrl.searchParams.set("status", "connected");
                redirectUrl.searchParams.set("userId", stateMeta.userId);
                redirectUrl.searchParams.set("scope", String(scope || ""));
                return res.redirect(redirectUrl.toString());
            }
            return sendOAuthResultPage(res, {
                ok: true,
                title: "Strava connected",
                message: "Authorization is complete. You can return to Rider Tracker and upload FIT files.",
                payload: {
                    type: "rider-tracker:strava-connected",
                    userId: stateMeta.userId,
                    scope: String(scope || "")
                }
            });
        } catch (exchangeError) {
            return sendOAuthResultPage(res, {
                ok: false,
                title: "Strava token exchange failed",
                message: exchangeError.message
            });
        }
    });

    router.get("/api/strava/connection", async (req, res) => {
        try {
            const userId = normalizeUserId(req.query.userId);
            const connection = await agentClient.stravaConnection();
            res.json({ ...connection, userId, expiresAt: connection.expires_at ?? null });
        } catch (error) {
            if (sendAgentUnavailable(res, error, { capability: "strava" })) return;
            res.status(502).json({ ok: false, error: error.message });
        }
    });

    router.post("/api/strava/upload-fit", (_req, res) => {
        res.status(410).json({
            ok: false,
            error: "Direct FIT upload is retired. Import the FIT into Rider before uploading it to Strava."
        });
    });

    router.post("/api/strava/upload-activity-fit", async (req, res) => {
        try {
            if (!await ensureConfigured(res)) return;
            const activityId = normalizeText(req.body.activityId);
            if (!activityId) {
                return res.status(400).json({ ok: false, error: "Activity id is required." });
            }
            const sourceMessage = normalizeText(req.body.message || req.body.generatedMessage);
            const fitDescription = normalizeText(req.body.fitDescription);
            const description = [fitDescription, sourceMessage].filter(Boolean).join("\n\n");
            const result = await agentClient.stravaUploadActivity({
                activity_key: activityId,
                title: normalizeText(req.body.activityName) || null,
                description: description || null,
                trainer: parseBoolean(req.body.trainer),
                commute: parseBoolean(req.body.commute),
                sport_type: normalizeText(req.body.sportType) || null
            });
            res.json({
                ok: true,
                userId: normalizeUserId(req.body.userId),
                activityId,
                upload: result.upload
            });
        } catch (error) {
            if (sendAgentUnavailable(res, error, { capability: "strava" })) return;
            const status = /activity not found/i.test(error.message) ? 404
                : /FIT path missing/i.test(error.message) ? 409 : 502;
            res.status(status).json({ ok: false, error: error.message });
        }
    });

    router.get("/api/strava/upload-status/:uploadId", async (req, res) => {
        try {
            const status = await agentClient.stravaUploadStatus(req.params.uploadId);
            res.json({
                ok: true,
                userId: normalizeUserId(req.query.userId),
                status
            });
        } catch (error) {
            if (sendAgentUnavailable(res, error, { capability: "strava" })) return;
            res.status(502).json({ ok: false, error: error.message });
        }
    });

    return router;
}
