import express from "express";
import crypto from "node:crypto";
import { createStravaClient } from "../strava-client.js";
import { buildStravaLoginPage } from "../pages/strava-login-page.js";
import { sendOAuthResultPage } from "../pages/oauth-result-page.js";
import { normalizeText, normalizeUserId, parseBoolean } from "../shared/http-utils.js";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export function createStravaRoutes({
    configStore,
    tokenStore,
    upload,
    clientId,
    clientSecret,
    scopes,
    redirectUri,
    frontendRedirectUrl
}) {
    const router = express.Router();
    const oauthStateMap = new Map();

    async function getStravaConfig() {
        if (clientId && clientSecret) {
            return {
                configured: true,
                source: "env",
                clientId,
                clientSecret,
                redirectUri,
                scopes
            };
        }

        const saved = await configStore.load();
        return {
            configured: Boolean(saved.clientId && saved.clientSecret),
            source: saved.clientId && saved.clientSecret ? "local" : "none",
            clientId: saved.clientId,
            clientSecret: saved.clientSecret,
            redirectUri,
            scopes
        };
    }

    function createClient(config) {
        return createStravaClient({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            redirectUri,
            scopes
        });
    }

    function ensureStravaConfig(res, config) {
        if (config.configured) return true;
        res.status(409).json({
            ok: false,
            configured: false,
            loginUrl: "/strava/login",
            error: "Missing Strava credentials. Open /strava/login to save Client ID and Client Secret."
        });
        return false;
    }

    async function sendConfigSummary(res) {
        const config = await getStravaConfig();
        return res.json({
            ok: true,
            configured: config.configured,
            source: config.source,
            loginUrl: "/strava/login",
            configPath: configStore.filePath,
            redirectUri,
            scopes
        });
    }

    async function ensureValidAccessToken(userId) {
        const config = await getStravaConfig();
        const current = await tokenStore.get(userId);

        if (!current) {
            throw new Error(`User ${userId} has not connected Strava yet. Call /api/strava/auth/start first.`);
        }

        const expiringSoon = Number(current.expires_at || 0) <= Math.floor(Date.now() / 1000) + 60;
        if (!expiringSoon) {
            return current.access_token;
        }

        const refreshed = await createClient(config).refreshToken(current.refresh_token);
        const nextToken = {
            ...toStoredTokenPayload(refreshed),
            athlete: refreshed.athlete ?? current.athlete ?? null
        };
        await tokenStore.set(userId, nextToken);
        return nextToken.access_token;
    }

    router.get("/api/strava/config", (_req, res) => {
        sendConfigSummary(res);
    });

    router.post("/api/strava/config", async (req, res) => {
        const nextClientId = normalizeText(req.body.clientId);
        const nextClientSecret = normalizeText(req.body.clientSecret);

        if (!nextClientId || !nextClientSecret) {
            return res.status(400).json({
                ok: false,
                error: "Client ID and Client Secret are required."
            });
        }

        await configStore.save({
            clientId: nextClientId,
            clientSecret: nextClientSecret,
            updatedAt: new Date().toISOString()
        });

        return sendConfigSummary(res);
    });

    router.get("/strava/login", async (req, res) => {
        const userId = normalizeUserId(req.query.userId);
        const config = await getStravaConfig();
        res.type("html").send(buildStravaLoginPage({
            userId,
            configured: config.configured,
            hasEnvCredentials: config.source === "env",
            redirectUri,
            scopes,
            configPath: configStore.filePath
        }));
    });

    router.get("/api/strava/auth/start", async (req, res) => {
        const config = await getStravaConfig();
        if (!ensureStravaConfig(res, config)) return;

        const userId = normalizeUserId(req.query.userId);
        const state = `${userId}:${crypto.randomBytes(12).toString("hex")}`;
        oauthStateMap.set(state, {
            userId,
            expiresAtMs: Date.now() + OAUTH_STATE_TTL_MS
        });

        res.json({
            ok: true,
            authUrl: createClient(config).buildAuthorizeUrl({ state }),
            state,
            userId
        });
    });

    router.get("/api/strava/auth/callback", async (req, res) => {
        const config = await getStravaConfig();
        if (!ensureStravaConfig(res, config)) return;

        const { code, state, error, scope } = req.query;

        if (error) {
            return sendOAuthResultPage(res, {
                ok: false,
                title: "Strava authorization failed",
                message: `Strava returned: ${String(error)}`
            });
        }

        if (!code || !state || !oauthStateMap.has(state)) {
            return sendOAuthResultPage(res, {
                ok: false,
                title: "Strava authorization expired",
                message: "Missing code/state, or the authorization state has expired. Please try connecting again."
            });
        }

        const stateMeta = oauthStateMap.get(state);
        oauthStateMap.delete(state);

        if (!stateMeta || stateMeta.expiresAtMs < Date.now()) {
            return sendOAuthResultPage(res, {
                ok: false,
                title: "Strava authorization expired",
                message: "The authorization state has expired. Please try connecting again."
            });
        }

        try {
            const tokenResponse = await createClient(config).exchangeCode(String(code));
            await tokenStore.set(stateMeta.userId, toStoredTokenPayload(tokenResponse));

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
        } catch (err) {
            return sendOAuthResultPage(res, {
                ok: false,
                title: "Strava token exchange failed",
                message: err.message
            });
        }
    });

    router.get("/api/strava/connection", async (req, res) => {
        const userId = normalizeUserId(req.query.userId);
        const token = await tokenStore.get(userId);
        const config = await getStravaConfig();

        if (!token) {
            return res.json({
                connected: false,
                configured: config.configured,
                userId
            });
        }

        return res.json({
            connected: true,
            configured: config.configured,
            userId,
            athlete: token.athlete ?? null,
            expiresAt: token.expires_at ?? null
        });
    });

    router.post("/api/strava/upload-fit", upload.single("file"), async (req, res) => {
        const config = await getStravaConfig();
        if (!ensureStravaConfig(res, config)) return;

        const userId = normalizeUserId(req.body.userId);
        const uploadedFile = req.file;

        if (!uploadedFile) {
            return res.status(400).json({
                ok: false,
                error: "Missing FIT file. Send multipart field named file."
            });
        }

        try {
            const accessToken = await ensureValidAccessToken(userId);
            const sourceMessage = normalizeText(req.body.message);
            const fitDescription = normalizeText(req.body.fitDescription);
            const fullDescription = [fitDescription, sourceMessage].filter(Boolean).join("\n\n");

            const uploadResponse = await createClient(config).createUpload({
                accessToken,
                fileBlob: new Blob([uploadedFile.buffer], { type: uploadedFile.mimetype || "application/vnd.ant.fit" }),
                filename: uploadedFile.originalname || `ride-${Date.now()}.fit`,
                dataType: "fit",
                name: normalizeText(req.body.activityName),
                description: fullDescription || undefined,
                trainer: parseBoolean(req.body.trainer),
                commute: parseBoolean(req.body.commute),
                externalId: normalizeText(req.body.externalId),
                sportType: normalizeText(req.body.sportType)
            });

            return res.json({
                ok: true,
                userId,
                upload: uploadResponse
            });
        } catch (err) {
            return res.status(500).json({
                ok: false,
                error: err.message
            });
        }
    });

    router.get("/api/strava/upload-status/:uploadId", async (req, res) => {
        const config = await getStravaConfig();
        if (!ensureStravaConfig(res, config)) return;

        const userId = normalizeUserId(req.query.userId);
        const uploadId = String(req.params.uploadId || "");

        if (!uploadId) {
            return res.status(400).json({
                ok: false,
                error: "Missing uploadId."
            });
        }

        try {
            const accessToken = await ensureValidAccessToken(userId);
            const status = await createClient(config).getUploadStatus({
                accessToken,
                uploadId
            });

            return res.json({
                ok: true,
                userId,
                status
            });
        } catch (err) {
            return res.status(500).json({
                ok: false,
                error: err.message
            });
        }
    });

    return router;
}

function toStoredTokenPayload(raw) {
    return {
        access_token: raw.access_token,
        refresh_token: raw.refresh_token,
        expires_at: raw.expires_at,
        athlete: raw.athlete ?? null,
        updated_at: new Date().toISOString()
    };
}
