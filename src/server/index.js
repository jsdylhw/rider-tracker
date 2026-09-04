import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createActivityRoutes } from "./routes/activity-routes.js";
import { createRouteLibraryRoutes } from "./routes/route-library-routes.js";
import { createStravaRoutes } from "./routes/strava-routes.js";
import { createAgentRoutes } from "./routes/agent-routes.js";
import { createNarrationRoutes } from "./routes/narration-routes.js";
import { createPersonalFitAgentClient } from "./personal-fit-agent-client.js";
import { sendAgentUnavailable } from "./agent-unavailable.js";
import { buildAllowedLocalOrigins, buildLocalBaseUrl, createLocalApiOriginGuard } from "./local-api-security.js";
import { withRequiredStravaScopes } from "../../scripts/local-config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

dotenv.config({ path: path.join(PROJECT_ROOT, ".env"), quiet: true });

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const SCOPES = withRequiredStravaScopes(process.env.STRAVA_SCOPES);
const APP_BASE_URL = process.env.APP_BASE_URL || buildLocalBaseUrl({
    host: HOST === "127.0.0.1" ? "localhost" : HOST,
    port: PORT
});
const REDIRECT_URI = process.env.STRAVA_REDIRECT_URI || `${APP_BASE_URL}/api/strava/auth/callback`;
const FRONTEND_REDIRECT_URL = process.env.FRONTEND_REDIRECT_URL || "";
const FIT_FILE_DIR = process.env.FIT_FILE_DIR || path.join(PROJECT_ROOT, "data", "files", "fit");
const PERSONAL_FIT_AGENT_URL = process.env.PERSONAL_FIT_AGENT_URL || "http://127.0.0.1:8000";
const PERSONAL_FIT_AGENT_TOKEN = process.env.PERSONAL_FIT_AGENT_TOKEN || "";
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";

const personalFitAgentClient = createPersonalFitAgentClient({
    baseUrl: PERSONAL_FIT_AGENT_URL,
    apiToken: PERSONAL_FIT_AGENT_TOKEN
});

app.use(express.json({ limit: "10mb" }));
app.use("/api", createLocalApiOriginGuard({
    allowedOrigins: buildAllowedLocalOrigins({
        host: HOST,
        port: PORT,
        appBaseUrl: APP_BASE_URL
    })
}));
app.use("/src", express.static(path.join(PROJECT_ROOT, "src")));
app.use("/vendor/@garmin/fitsdk", express.static(path.join(PROJECT_ROOT, "node_modules", "@garmin", "fitsdk")));
app.use(createActivityRoutes({
    agentClient: personalFitAgentClient,
    upload,
    fitFileDir: FIT_FILE_DIR,
    projectRoot: PROJECT_ROOT
}));
app.use(createRouteLibraryRoutes({ agentClient: personalFitAgentClient }));
app.use(createStravaRoutes({
    agentClient: personalFitAgentClient,
    scopes: SCOPES,
    redirectUri: REDIRECT_URI,
    frontendRedirectUrl: FRONTEND_REDIRECT_URL
}));
app.use(createAgentRoutes({ agentClient: personalFitAgentClient }));
app.use(createNarrationRoutes({ agentClient: personalFitAgentClient }));

app.get("/", (_req, res) => {
    res.sendFile(path.join(PROJECT_ROOT, "index.html"));
});

app.get("/api/runtime-config/maps", (_req, res) => {
    res.json({
        ok: true,
        configured: Boolean(GOOGLE_MAPS_API_KEY),
        apiKey: GOOGLE_MAPS_API_KEY
    });
});

app.get("/api/user-profile", async (_req, res) => {
    try {
        const athlete = await personalFitAgentClient.athleteProfile();
        res.json({
            ok: true,
            profile: athlete?.rider_settings ?? {}
        });
    } catch (error) {
        if (sendAgentUnavailable(res, error, { capability: "athlete_profile" })) return;
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.put("/api/user-profile", async (req, res) => {
    try {
        const requested = sanitizeUserProfile(req.body ?? {});
        const athlete = await personalFitAgentClient.updateAthleteProfile(requested);
        res.json({
            ok: true,
            profile: athlete?.rider_settings ?? {}
        });
    } catch (error) {
        if (sendAgentUnavailable(res, error, { capability: "athlete_profile" })) return;
        res.status(400).json({ ok: false, error: error.message });
    }
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
});

server.on("error", (err) => {
    console.error(`[rider-tracker] server error: ${err.message}`);
    process.exitCode = 1;
});

function sanitizeUserProfile(profile) {
    const next = {};
    const fields = {
        power: [0, 600],
        mass: [40, 150],
        ftp: [120, 450],
        restingHr: [40, 100],
        maxHr: [120, 220],
        cda: [0.2, 0.8],
        crr: [0.001, 0.02],
        windSpeed: [-10, 10]
    };

    for (const [key, [min, max]] of Object.entries(fields)) {
        if (profile[key] === undefined || profile[key] === null || profile[key] === "") {
            continue;
        }

        const value = Number(profile[key]);
        if (!Number.isFinite(value)) {
            throw new Error(`Invalid user profile field: ${key}`);
        }
        next[key] = Math.min(max, Math.max(min, value));
    }

    return next;
}
