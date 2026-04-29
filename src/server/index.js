import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createConfigStore } from "./config-store.js";
import { createTokenStore } from "./token-store.js";
import { createActivityStore } from "./activity-store.js";
import { createActivityRoutes } from "./routes/activity-routes.js";
import { createStravaRoutes } from "./routes/strava-routes.js";

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
const FIT_FILE_DIR = process.env.FIT_FILE_DIR || path.join(PROJECT_ROOT, "data", "files", "fit");

const configStore = createConfigStore(CONFIG_STORE_PATH);
const tokenStore = createTokenStore(TOKEN_STORE_PATH);
const activityStore = createActivityStore();
activityStore.initialize();

app.use(cors());
app.use(express.json());
app.use("/src", express.static(path.join(PROJECT_ROOT, "src")));
app.use(createActivityRoutes({
    activityStore,
    upload,
    fitFileDir: FIT_FILE_DIR,
    projectRoot: PROJECT_ROOT
}));
app.use(createStravaRoutes({
    configStore,
    tokenStore,
    upload,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    scopes: SCOPES,
    redirectUri: REDIRECT_URI,
    frontendRedirectUrl: FRONTEND_REDIRECT_URL
}));

app.get("/", (_req, res) => {
    res.sendFile(path.join(PROJECT_ROOT, "index.html"));
});

app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "rider-tracker" });
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
