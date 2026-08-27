import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

export function loadUnifiedConfig(projectRoot, env = process.env) {
    const configPath = path.resolve(env.RIDER_CONFIG_PATH || path.join(projectRoot, "config.yaml"));
    let raw;
    try {
        raw = readFileSync(configPath, "utf8");
    } catch (error) {
        if (error?.code === "ENOENT") return { configPath, values: {} };
        throw error;
    }
    const values = parse(raw) ?? {};
    if (!isObject(values)) throw new Error(`配置文件必须是 YAML object: ${configPath}`);
    return { configPath, values };
}

export function buildRuntimeEnv(projectRoot, unifiedConfig, baseEnv = process.env) {
    const { configPath, values } = unifiedConfig;
    const rider = objectValue(values.rider);
    const trainingAgent = objectValue(values.training_agent);
    const agent = objectValue(values.agent);
    const env = { ...baseEnv };

    setDefault(env, "HOST", rider.host);
    setDefault(env, "PORT", rider.port);
    setDefault(env, "APP_BASE_URL", rider.app_base_url);
    setDefault(env, "FRONTEND_REDIRECT_URL", rider.frontend_redirect_url);
    setDefault(env, "STRAVA_REDIRECT_URI", rider.strava_redirect_uri);
    setDefault(env, "STRAVA_SCOPES", rider.strava_scopes);
    setPathDefault(
        env,
        "RIDER_TRACKER_DB_PATH",
        projectRoot,
        rider.database_path || "data/rider-tracker.db"
    );
    setPathDefault(env, "FIT_FILE_DIR", projectRoot, rider.fit_file_dir || "data/files/fit");
    setDefault(env, "TRAINING_AGENT_DB_PATH", env.RIDER_TRACKER_DB_PATH);
    setDefault(env, "TRAINING_AGENT_MANAGED_DATABASE", "1");
    setDefault(env, "RIDER_DATABASE_MANAGED", "1");
    setDefault(env, "RIDER_PROJECT_ROOT", projectRoot);

    const endpointOverride = parseHttpEndpoint(env.PERSONAL_FIT_AGENT_URL);
    const agentHost = String(endpointOverride?.hostname || trainingAgent.host || "127.0.0.1");
    const agentPort = String(endpointOverride?.port || trainingAgent.port || "8000");
    setDefault(env, "PERSONAL_FIT_AGENT_HOST", agentHost);
    setDefault(env, "PERSONAL_FIT_AGENT_PORT", agentPort);
    setDefault(
        env,
        "PERSONAL_FIT_AGENT_URL",
        `http://${env.PERSONAL_FIT_AGENT_HOST}:${env.PERSONAL_FIT_AGENT_PORT}`
    );
    setDefault(env, "PERSONAL_FIT_AGENT_TOKEN", values.web_api_token);
    setDefault(env, "PYTHON_EXECUTABLE", trainingAgent.python_executable);
    setDefault(env, "TRAINING_AGENT_CONFIG_PATH", configPath);
    appendProxyBypass(env, endpointHostname(agent.base_url));
    return env;
}

function setDefault(env, name, value) {
    if (env[name] !== undefined && env[name] !== "") return;
    if (value === undefined || value === null || value === "") return;
    env[name] = String(value);
}

function setPathDefault(env, name, projectRoot, value) {
    if (!value) return;
    setDefault(env, name, path.resolve(projectRoot, String(value)));
}

function objectValue(value) {
    return isObject(value) ? value : {};
}

function parseHttpEndpoint(value) {
    if (!value) return null;
    try {
        const endpoint = new URL(String(value));
        return endpoint.protocol === "http:" || endpoint.protocol === "https:" ? endpoint : null;
    } catch {
        return null;
    }
}

function endpointHostname(value) {
    try {
        const endpoint = new URL(String(value || ""));
        return endpoint.protocol === "https:" || endpoint.protocol === "http:"
            ? endpoint.hostname
            : "";
    } catch {
        return "";
    }
}

function appendProxyBypass(env, hostname) {
    if (!hostname) return;
    const entries = new Set(
        [env.NO_PROXY, env.no_proxy]
            .filter(Boolean)
            .flatMap((value) => String(value).split(","))
            .map((value) => value.trim())
            .filter(Boolean)
    );
    entries.add(hostname);
    const value = [...entries].join(",");
    env.NO_PROXY = value;
    env.no_proxy = value;
}

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
