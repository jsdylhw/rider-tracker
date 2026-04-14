import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "node:crypto";
import { createStravaClient } from "./strava-client.js";
import { createTokenStore } from "./token-store.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = Number(process.env.PORT || 8787);
const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const SCOPES = process.env.STRAVA_SCOPES || "activity:read_all,activity:write";
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const REDIRECT_URI = process.env.STRAVA_REDIRECT_URI || `${APP_BASE_URL}/api/strava/auth/callback`;
const FRONTEND_REDIRECT_URL = process.env.FRONTEND_REDIRECT_URL || "";
const TOKEN_STORE_PATH = process.env.TOKEN_STORE_PATH;

const tokenStore = createTokenStore(TOKEN_STORE_PATH);
const stravaClient = createStravaClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    scopes: SCOPES
});

const oauthStateMap = new Map();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

app.use(cors());
app.use(express.json());

app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "rider-tracker-strava-server" });
});

app.get("/api/strava/auth/start", (req, res) => {
    ensureStravaConfig(res);
    if (res.headersSent) return;

    const userId = normalizeUserId(req.query.userId);
    const state = `${userId}:${crypto.randomBytes(12).toString("hex")}`;
    oauthStateMap.set(state, {
        userId,
        expiresAtMs: Date.now() + OAUTH_STATE_TTL_MS
    });

    const authUrl = stravaClient.buildAuthorizeUrl({ state });
    res.json({
        authUrl,
        state,
        userId
    });
});

app.get("/api/strava/auth/callback", async (req, res) => {
    ensureStravaConfig(res);
    if (res.headersSent) return;

    const { code, state, error, scope } = req.query;

    if (error) {
        return res.status(400).json({
            ok: false,
            error: `Strava 授权失败：${error}`
        });
    }

    if (!code || !state || !oauthStateMap.has(state)) {
        return res.status(400).json({
            ok: false,
            error: "授权回调缺少 code/state，或 state 已过期。"
        });
    }

    const stateMeta = oauthStateMap.get(state);
    oauthStateMap.delete(state);

    if (!stateMeta || stateMeta.expiresAtMs < Date.now()) {
        return res.status(400).json({
            ok: false,
            error: "授权 state 已过期，请重新发起授权。"
        });
    }

    try {
        const tokenResponse = await stravaClient.exchangeCode(String(code));
        await tokenStore.set(stateMeta.userId, toStoredTokenPayload(tokenResponse));

        if (FRONTEND_REDIRECT_URL) {
            const redirectUrl = new URL(FRONTEND_REDIRECT_URL);
            redirectUrl.searchParams.set("status", "connected");
            redirectUrl.searchParams.set("userId", stateMeta.userId);
            redirectUrl.searchParams.set("scope", String(scope || ""));
            return res.redirect(redirectUrl.toString());
        }

        return res.json({
            ok: true,
            userId: stateMeta.userId,
            athlete: tokenResponse.athlete ?? null,
            scope: String(scope || "")
        });
    } catch (err) {
        return res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});

app.get("/api/strava/connection", async (req, res) => {
    const userId = normalizeUserId(req.query.userId);
    const token = await tokenStore.get(userId);

    if (!token) {
        return res.json({
            connected: false,
            userId
        });
    }

    return res.json({
        connected: true,
        userId,
        athlete: token.athlete ?? null,
        expiresAt: token.expires_at ?? null
    });
});

app.post("/api/strava/upload-fit", upload.single("file"), async (req, res) => {
    ensureStravaConfig(res);
    if (res.headersSent) return;

    const userId = normalizeUserId(req.body.userId);
    const uploadedFile = req.file;

    if (!uploadedFile) {
        return res.status(400).json({
            ok: false,
            error: "缺少 FIT 文件（multipart 字段名需为 file）。"
        });
    }

    try {
        const accessToken = await ensureValidAccessToken(userId);
        const sourceMessage = normalizeText(req.body.message);
        const fitDescription = normalizeText(req.body.fitDescription);
        const fullDescription = [fitDescription, sourceMessage].filter(Boolean).join("\n\n");

        const uploadResponse = await stravaClient.createUpload({
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

app.get("/api/strava/upload-status/:uploadId", async (req, res) => {
    ensureStravaConfig(res);
    if (res.headersSent) return;

    const userId = normalizeUserId(req.query.userId);
    const uploadId = String(req.params.uploadId || "");

    if (!uploadId) {
        return res.status(400).json({
            ok: false,
            error: "缺少 uploadId。"
        });
    }

    try {
        const accessToken = await ensureValidAccessToken(userId);
        const status = await stravaClient.getUploadStatus({
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

app.listen(PORT, () => {
    console.log(`[strava-server] listening on ${APP_BASE_URL}`);
    if (!CLIENT_ID || !CLIENT_SECRET) {
        console.warn("[strava-server] STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET 未配置，授权与上传接口不可用。");
    }
});

function ensureStravaConfig(res) {
    if (!CLIENT_ID || !CLIENT_SECRET) {
        res.status(500).json({
            ok: false,
            error: "服务端缺少 STRAVA_CLIENT_ID 或 STRAVA_CLIENT_SECRET 配置。"
        });
    }
}

function normalizeUserId(value) {
    const text = String(value || "").trim();
    return text || "default";
}

function normalizeText(value) {
    const text = String(value || "").trim();
    return text || "";
}

function parseBoolean(value) {
    if (typeof value === "boolean") return value;
    const normalized = String(value || "").toLowerCase();
    if (!normalized) return undefined;
    return normalized === "1" || normalized === "true" || normalized === "yes";
}

async function ensureValidAccessToken(userId) {
    const current = await tokenStore.get(userId);

    if (!current) {
        throw new Error(`用户 ${userId} 尚未完成 Strava 授权，请先调用 /api/strava/auth/start。`);
    }

    const expiringSoon = Number(current.expires_at || 0) <= Math.floor(Date.now() / 1000) + 60;
    if (!expiringSoon) {
        return current.access_token;
    }

    const refreshed = await stravaClient.refreshToken(current.refresh_token);
    const nextToken = {
        ...toStoredTokenPayload(refreshed),
        athlete: refreshed.athlete ?? current.athlete ?? null
    };
    await tokenStore.set(userId, nextToken);
    return nextToken.access_token;
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
