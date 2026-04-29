import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createStravaClient } from "./strava-client.js";
import { createConfigStore } from "./config-store.js";
import { createTokenStore } from "./token-store.js";
import { createActivityStore } from "./activity-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

dotenv.config({ path: path.join(PROJECT_ROOT, ".env"), quiet: true });

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const SCOPES = process.env.STRAVA_SCOPES || "activity:read_all,activity:write";
const APP_BASE_URL = process.env.APP_BASE_URL || `http://${HOST === "127.0.0.1" ? "localhost" : HOST}:${PORT}`;
const REDIRECT_URI = process.env.STRAVA_REDIRECT_URI || `${APP_BASE_URL}/api/strava/auth/callback`;
const FRONTEND_REDIRECT_URL = process.env.FRONTEND_REDIRECT_URL || "";
const CONFIG_STORE_PATH = process.env.STRAVA_CONFIG_PATH;
const TOKEN_STORE_PATH = process.env.TOKEN_STORE_PATH;

const configStore = createConfigStore(CONFIG_STORE_PATH);
const tokenStore = createTokenStore(TOKEN_STORE_PATH);
const activityStore = createActivityStore();
activityStore.initialize();

const oauthStateMap = new Map();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

app.use(cors());
app.use(express.json());
app.use("/src", express.static(path.join(PROJECT_ROOT, "src")));

app.get("/", (_req, res) => {
    res.sendFile(path.join(PROJECT_ROOT, "index.html"));
});

app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "rider-tracker" });
});

app.get("/api/activities", (req, res) => {
    try {
        const activities = activityStore.listActivities({
            limit: req.query.limit
        });
        return res.json({
            ok: true,
            dbPath: activityStore.filePath,
            summary: activityStore.getSummary(),
            activities
        });
    } catch (err) {
        return res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});

app.post("/api/activities/rider-session", (req, res) => {
    try {
        const activity = activityStore.saveRiderSession(req.body?.session, {
            name: req.body?.name,
            sportType: req.body?.sportType
        });
        return res.json({
            ok: true,
            dbPath: activityStore.filePath,
            activity
        });
    } catch (err) {
        return res.status(400).json({
            ok: false,
            error: err.message
        });
    }
});

app.get("/api/activities/:activityId", (req, res) => {
    try {
        const activity = activityStore.getActivityDetail(req.params.activityId);
        if (!activity) {
            return res.status(404).json({
                ok: false,
                error: "Activity not found."
            });
        }

        return res.json({
            ok: true,
            activity
        });
    } catch (err) {
        return res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});

app.patch("/api/activities/:activityId", (req, res) => {
    try {
        const activity = activityStore.updateActivityName(req.params.activityId, req.body?.name);
        return res.json({
            ok: true,
            activity
        });
    } catch (err) {
        return res.status(err.message === "Activity not found." ? 404 : 400).json({
            ok: false,
            error: err.message
        });
    }
});

app.delete("/api/activities/:activityId", (req, res) => {
    try {
        const activity = activityStore.deleteActivity(req.params.activityId);
        return res.json({
            ok: true,
            activity
        });
    } catch (err) {
        return res.status(err.message === "Activity not found." ? 404 : 400).json({
            ok: false,
            error: err.message
        });
    }
});

app.get("/api/strava/config", (_req, res) => {
    sendConfigSummary(res);
});

app.post("/api/strava/config", async (req, res) => {
    const clientId = normalizeText(req.body.clientId);
    const clientSecret = normalizeText(req.body.clientSecret);

    if (!clientId || !clientSecret) {
        return res.status(400).json({
            ok: false,
            error: "Client ID and Client Secret are required."
        });
    }

    await configStore.save({
        clientId,
        clientSecret,
        updatedAt: new Date().toISOString()
    });

    return sendConfigSummary(res);
});

app.get("/strava/login", async (req, res) => {
    const userId = normalizeUserId(req.query.userId);
    const config = await getStravaConfig();
    res.type("html").send(buildStravaLoginPage({
        userId,
        configured: config.configured,
        hasEnvCredentials: config.source === "env",
        redirectUri: REDIRECT_URI,
        scopes: SCOPES,
        configPath: configStore.filePath
    }));
});

async function sendConfigSummary(res) {
    const config = await getStravaConfig();
    return res.json({
        ok: true,
        configured: config.configured,
        source: config.source,
        loginUrl: "/strava/login",
        configPath: configStore.filePath,
        redirectUri: REDIRECT_URI,
        scopes: SCOPES
    });
}

app.get("/api/strava/auth/start", async (req, res) => {
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

app.get("/api/strava/auth/callback", async (req, res) => {
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

        if (FRONTEND_REDIRECT_URL) {
            const redirectUrl = new URL(FRONTEND_REDIRECT_URL);
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

app.get("/api/strava/connection", async (req, res) => {
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

app.post("/api/strava/upload-fit", upload.single("file"), async (req, res) => {
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

app.get("/api/strava/upload-status/:uploadId", async (req, res) => {
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

const server = app.listen(PORT, HOST, (err) => {
    if (err) {
        console.error(`[rider-tracker] failed to listen on ${APP_BASE_URL}: ${err.message}`);
        process.exitCode = 1;
        return;
    }

    console.log(`[rider-tracker] listening on ${APP_BASE_URL}`);
    if (!CLIENT_ID || !CLIENT_SECRET) {
        console.warn(`[rider-tracker] Strava env credentials are not configured. Use ${APP_BASE_URL}/strava/login to save local credentials.`);
    }
});

server.on("error", (err) => {
    console.error(`[rider-tracker] server error: ${err.message}`);
    process.exitCode = 1;
});

async function getStravaConfig() {
    if (CLIENT_ID && CLIENT_SECRET) {
        return {
            configured: true,
            source: "env",
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
            redirectUri: REDIRECT_URI,
            scopes: SCOPES
        };
    }

    const saved = await configStore.load();
    return {
        configured: Boolean(saved.clientId && saved.clientSecret),
        source: saved.clientId && saved.clientSecret ? "local" : "none",
        clientId: saved.clientId,
        clientSecret: saved.clientSecret,
        redirectUri: REDIRECT_URI,
        scopes: SCOPES
    };
}

function createClient(config) {
    return createStravaClient({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: REDIRECT_URI,
        scopes: SCOPES
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

function buildStravaLoginPage({ userId, configured, hasEnvCredentials, redirectUri, scopes, configPath }) {
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Strava Login - Rider Tracker</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #f3f5fb; color: #222f3e; }
    main { width: min(680px, calc(100vw - 32px)); padding: 28px; background: #fff; border: 1px solid #dfe4ea; border-radius: 14px; box-shadow: 0 18px 45px rgba(15, 23, 42, 0.08); }
    h1 { margin: 0 0 8px; font-size: 26px; }
    p { color: #64748b; line-height: 1.6; }
    form { display: grid; gap: 14px; margin-top: 18px; }
    label { display: grid; gap: 6px; color: #64748b; font-size: 13px; font-weight: 700; }
    input { border: 1px solid #dfe4ea; border-radius: 10px; padding: 11px 12px; font-size: 15px; }
    button { border: 0; border-radius: 10px; padding: 12px 16px; background: #fc4c02; color: #fff; font-weight: 800; cursor: pointer; }
    button.secondary { background: #3742fa; }
    dl { display: grid; gap: 8px; padding: 12px; background: #f8fafc; border: 1px solid #dfe4ea; border-radius: 12px; }
    div.row { display: grid; grid-template-columns: 110px 1fr; gap: 10px; font-size: 13px; }
    dt { color: #64748b; font-weight: 800; }
    dd { margin: 0; word-break: break-all; }
    #status { min-height: 24px; font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <h1>连接 Strava</h1>
    <p>保存 Strava API 的 Client ID 和 Client Secret 后，Rider Tracker 会继续打开 Strava 授权页面。</p>
    <dl>
      <div class="row"><dt>Callback</dt><dd>${escapeHtml(redirectUri)}</dd></div>
      <div class="row"><dt>Scopes</dt><dd>${escapeHtml(scopes)}</dd></div>
      <div class="row"><dt>Config</dt><dd>${escapeHtml(configPath)}</dd></div>
    </dl>
    ${hasEnvCredentials ? `<p id="status">已从 .env 读取 Strava 配置。</p><button id="connectBtn" class="secondary" type="button">继续授权 Strava</button>` : `
    <form id="configForm">
      <label>Client ID<input name="clientId" inputmode="numeric" autocomplete="off" placeholder="12345" ${configured ? "" : "required"}></label>
      <label>Client Secret<input name="clientSecret" type="password" autocomplete="off" placeholder="Strava app client secret" ${configured ? "" : "required"}></label>
      <button type="submit">${configured ? "更新配置并连接 Strava" : "保存配置并连接 Strava"}</button>
    </form>
    <p id="status">${configured ? "已保存本地 Strava 配置，可以继续授权。" : "等待保存 Strava 配置。"}</p>`}
  </main>
  <script>
    const userId = ${JSON.stringify(userId)};
    const form = document.getElementById("configForm");
    const connectBtn = document.getElementById("connectBtn");
    const statusEl = document.getElementById("status");

    async function connect() {
      statusEl.textContent = "正在创建 Strava 授权链接...";
      const response = await fetch("/api/strava/auth/start?userId=" + encodeURIComponent(userId));
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.ok === false) {
        throw new Error(body?.error || response.statusText || "Failed to start Strava authorization.");
      }
      window.location.href = body.authUrl;
    }

    if (connectBtn) {
      connectBtn.addEventListener("click", () => connect().catch((error) => {
        statusEl.textContent = error.message;
      }));
    }

    if (form) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const data = new FormData(form);
        statusEl.textContent = "正在保存配置...";
        try {
          const response = await fetch("/api/strava/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              clientId: data.get("clientId"),
              clientSecret: data.get("clientSecret")
            })
          });
          const body = await response.json().catch(() => null);
          if (!response.ok || body?.ok === false) {
            throw new Error(body?.error || response.statusText || "Failed to save Strava config.");
          }
          await connect();
        } catch (error) {
          statusEl.textContent = error.message;
        }
      });
    }
  </script>
</body>
</html>`;
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

function sendOAuthResultPage(res, { ok, title, message, payload = null }) {
    const safePayload = JSON.stringify(payload || { type: "rider-tracker:strava-error", message });
    res.status(ok ? 200 : 400).type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #f3f5fb; color: #222f3e; }
    main { max-width: 520px; padding: 28px; background: #fff; border: 1px solid #dfe4ea; border-radius: 14px; box-shadow: 0 18px 45px rgba(15, 23, 42, 0.08); }
    h1 { margin: 0 0 10px; font-size: 24px; }
    p { margin: 0; color: #64748b; line-height: 1.6; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </main>
  <script>
    const payload = ${safePayload};
    if (window.opener) {
      window.opener.postMessage(payload, window.location.origin);
      window.setTimeout(() => window.close(), 800);
    }
  </script>
</body>
</html>`);
}

function escapeHtml(value) {
    return String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
