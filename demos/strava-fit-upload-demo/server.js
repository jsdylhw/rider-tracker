import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 8797);
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const REDIRECT_URI = `${APP_BASE_URL}/api/auth/callback`;
const CONFIG_DIR = path.join(os.homedir(), ".config", "rider-tracker-strava-demo");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const SCOPES = "activity:write,activity:read_all";
const STRAVA_API_BASE = "https://www.strava.com/api/v3";
const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

const staticDir = path.dirname(new URL(import.meta.url).pathname);

createServer(async (req, res) => {
    try {
        const url = new URL(req.url || "/", APP_BASE_URL);

        if (req.method === "GET" && url.pathname === "/") {
            return sendFile(res, path.join(staticDir, "index.html"), "text/html; charset=utf-8");
        }
        if (req.method === "GET" && url.pathname === "/app.js") {
            return sendFile(res, path.join(staticDir, "app.js"), "text/javascript; charset=utf-8");
        }
        if (req.method === "GET" && url.pathname === "/style.css") {
            return sendFile(res, path.join(staticDir, "style.css"), "text/css; charset=utf-8");
        }
        if (req.method === "GET" && url.pathname === "/api/config") {
            return sendJson(res, await getConfigSummary());
        }
        if (req.method === "POST" && url.pathname === "/api/config") {
            const body = await readJsonBody(req);
            const clientId = String(body.clientId || "").trim();
            const clientSecret = String(body.clientSecret || "").trim();
            if (!clientId || !clientSecret) {
                return sendJson(res, { ok: false, error: "Client ID and Client Secret are required." }, 400);
            }
            await saveConfig({ clientId, clientSecret });
            return sendJson(res, { ok: true, ...(await getConfigSummary()) });
        }
        if (req.method === "GET" && url.pathname === "/api/auth/start") {
            return startAuth(res);
        }
        if (req.method === "GET" && url.pathname === "/api/auth/callback") {
            return handleAuthCallback(url, res);
        }
        if (req.method === "POST" && url.pathname === "/api/upload-fit") {
            return uploadFit(req, res);
        }
        if (req.method === "GET" && url.pathname.startsWith("/api/uploads/")) {
            const uploadId = decodeURIComponent(url.pathname.replace("/api/uploads/", ""));
            return getUploadStatus(uploadId, res);
        }

        return sendJson(res, { ok: false, error: "Not found." }, 404);
    } catch (error) {
        console.error(error);
        return sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
}).listen(PORT, () => {
    console.log(`[strava-fit-upload-demo] ${APP_BASE_URL}`);
    console.log(`[strava-fit-upload-demo] config: ${CONFIG_FILE}`);
});

async function startAuth(res) {
    const config = await loadConfig();
    requireClientCredentials(config);

    const state = crypto.randomBytes(16).toString("hex");
    await saveConfig({ oauthState: state });

    const query = new URLSearchParams({
        client_id: String(config.clientId),
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        approval_prompt: "auto",
        scope: SCOPES,
        state
    });

    return sendJson(res, {
        ok: true,
        authUrl: `${STRAVA_AUTHORIZE_URL}?${query.toString()}`,
        redirectUri: REDIRECT_URI,
        scopes: SCOPES
    });
}

async function handleAuthCallback(url, res) {
    const config = await loadConfig();
    requireClientCredentials(config);

    const error = url.searchParams.get("error");
    if (error) {
        return sendHtml(res, `<h1>Strava authorization failed</h1><p>${escapeHtml(error)}</p>`, 400);
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state || state !== config.oauthState) {
        return sendHtml(res, "<h1>Invalid callback</h1><p>Missing code/state or state mismatch.</p>", 400);
    }

    const tokenResponse = await exchangeCode({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        code
    });

    await saveConfig({
        oauthState: null,
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token,
        expiresAt: tokenResponse.expires_at,
        athlete: tokenResponse.athlete ?? null,
        updatedAt: new Date().toISOString()
    });

    const athlete = tokenResponse.athlete
        ? `${tokenResponse.athlete.firstname || ""} ${tokenResponse.athlete.lastname || ""}`.trim()
        : "Strava";
    return sendHtml(res, `<h1>Connected</h1><p>${escapeHtml(athlete)} is connected. You can close this tab.</p>`);
}

async function uploadFit(req, res) {
    const config = await loadConfig();
    requireClientCredentials(config);

    const accessToken = await ensureAccessToken(config);
    const { fields, files } = parseMultipart(await readRequestBuffer(req), req.headers["content-type"]);
    const file = files.file;

    if (!file) {
        return sendJson(res, { ok: false, error: "Missing multipart file field named file." }, 400);
    }
    if (file.data.length > MAX_UPLOAD_BYTES) {
        return sendJson(res, { ok: false, error: "FIT file is too large for this demo." }, 413);
    }

    const upload = await createStravaUpload({
        accessToken,
        file,
        name: fields.name,
        description: fields.description,
        trainer: fields.trainer,
        commute: fields.commute,
        sportType: fields.sportType,
        externalId: fields.externalId
    });

    return sendJson(res, {
        ok: true,
        upload
    }, 201);
}

async function getUploadStatus(uploadId, res) {
    if (!uploadId) {
        return sendJson(res, { ok: false, error: "Missing upload id." }, 400);
    }

    const config = await loadConfig();
    const accessToken = await ensureAccessToken(config);
    const response = await fetch(`${STRAVA_API_BASE}/uploads/${encodeURIComponent(uploadId)}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    const body = await readStravaJson(response, "Get upload status");

    return sendJson(res, {
        ok: true,
        status: body
    });
}

async function createStravaUpload({ accessToken, file, name, description, trainer, commute, sportType, externalId }) {
    const body = new FormData();
    body.append("file", new Blob([file.data], { type: file.contentType || "application/vnd.ant.fit" }), file.filename || `ride-${Date.now()}.fit`);
    body.append("data_type", "fit");

    if (name) body.append("name", name);
    if (description) body.append("description", description);
    if (trainer) body.append("trainer", normalizeBooleanFormValue(trainer));
    if (commute) body.append("commute", normalizeBooleanFormValue(commute));
    if (sportType) body.append("sport_type", sportType);
    if (externalId) body.append("external_id", externalId);

    const response = await fetch(`${STRAVA_API_BASE}/uploads`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body
    });

    return readStravaJson(response, "Upload FIT");
}

async function ensureAccessToken(config = null) {
    const current = config ?? await loadConfig();
    if (!current.accessToken || !current.refreshToken) {
        throw new Error("Strava is not connected. Complete OAuth first.");
    }

    const expiresAt = Number(current.expiresAt || 0);
    const expiresSoon = expiresAt <= Math.floor(Date.now() / 1000) + 60;
    if (!expiresSoon) {
        return current.accessToken;
    }

    const refreshed = await refreshAccessToken(current);
    await saveConfig({
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        expiresAt: refreshed.expires_at,
        athlete: refreshed.athlete ?? current.athlete ?? null,
        updatedAt: new Date().toISOString()
    });
    return refreshed.access_token;
}

async function exchangeCode({ clientId, clientSecret, code }) {
    return requestToken(new URLSearchParams({
        client_id: String(clientId),
        client_secret: String(clientSecret),
        code,
        grant_type: "authorization_code"
    }));
}

async function refreshAccessToken(config) {
    return requestToken(new URLSearchParams({
        client_id: String(config.clientId),
        client_secret: String(config.clientSecret),
        grant_type: "refresh_token",
        refresh_token: String(config.refreshToken)
    }));
}

async function requestToken(payload) {
    const response = await fetch(STRAVA_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: payload.toString()
    });
    return readStravaJson(response, "Strava token");
}

async function readStravaJson(response, label) {
    const text = await response.text();
    let body = {};
    try {
        body = text ? JSON.parse(text) : {};
    } catch {
        body = { message: text };
    }
    if (!response.ok) {
        const message = body.message || body.error || JSON.stringify(body);
        throw new Error(`${label} failed (${response.status}): ${message}`);
    }
    return body;
}

async function getConfigSummary() {
    const config = await loadConfig();
    return {
        ok: true,
        configPath: CONFIG_FILE,
        redirectUri: REDIRECT_URI,
        scopes: SCOPES,
        hasClientId: Boolean(config.clientId),
        hasClientSecret: Boolean(config.clientSecret),
        connected: Boolean(config.accessToken && config.refreshToken),
        athlete: config.athlete ?? null,
        expiresAt: config.expiresAt ?? null
    };
}

async function loadConfig() {
    try {
        const content = await fs.readFile(CONFIG_FILE, "utf8");
        return JSON.parse(content);
    } catch (error) {
        if (error.code === "ENOENT") return {};
        throw error;
    }
}

async function saveConfig(patch) {
    const current = await loadConfig();
    const next = { ...current, ...patch };
    Object.keys(next).forEach((key) => {
        if (next[key] === null || next[key] === undefined) {
            delete next[key];
        }
    });
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), "utf8");
}

function requireClientCredentials(config) {
    if (!config.clientId || !config.clientSecret) {
        throw new Error("Missing Strava Client ID or Client Secret. Save config first.");
    }
}

async function sendFile(res, filePath, contentType) {
    const content = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
}

function sendJson(res, body, status = 200) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body, null, 2));
}

function sendHtml(res, html, status = 200) {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body>${html}</body></html>`);
}

async function readJsonBody(req) {
    const buffer = await readRequestBuffer(req);
    if (!buffer.length) return {};
    return JSON.parse(buffer.toString("utf8"));
}

async function readRequestBuffer(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

function parseMultipart(buffer, contentType) {
    const boundaryMatch = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!boundaryMatch) {
        throw new Error("Expected multipart/form-data with a boundary.");
    }

    const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
    const fields = {};
    const files = {};
    let offset = 0;

    while (offset < buffer.length) {
        const boundaryStart = buffer.indexOf(boundary, offset);
        if (boundaryStart === -1) break;

        const partStart = boundaryStart + boundary.length;
        if (buffer.slice(partStart, partStart + 2).toString() === "--") break;

        const headerStart = partStart + 2;
        const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), headerStart);
        if (headerEnd === -1) break;

        const nextBoundary = buffer.indexOf(boundary, headerEnd + 4);
        if (nextBoundary === -1) break;

        const headers = buffer.slice(headerStart, headerEnd).toString("utf8");
        const body = buffer.slice(headerEnd + 4, Math.max(headerEnd + 4, nextBoundary - 2));
        const disposition = headers.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || "";
        const name = disposition.match(/name="([^"]+)"/i)?.[1];
        const filename = disposition.match(/filename="([^"]*)"/i)?.[1];
        const contentTypeHeader = headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim();

        if (name) {
            if (filename !== undefined) {
                files[name] = {
                    filename,
                    contentType: contentTypeHeader,
                    data: body
                };
            } else {
                fields[name] = body.toString("utf8");
            }
        }

        offset = nextBoundary;
    }

    return { fields, files };
}

function normalizeBooleanFormValue(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on" ? "1" : "0";
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}
