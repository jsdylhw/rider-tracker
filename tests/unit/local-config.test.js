import path from "node:path";
import { buildRuntimeEnv } from "../../scripts/local-config.js";
import { assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "local-config",
    tests: [
        {
            name: "maps one YAML configuration to Rider and Agent runtime variables",
            run() {
                const root = path.resolve("/tmp/rider-config-test");
                const env = buildRuntimeEnv(root, {
                    configPath: path.join(root, "config.yaml"),
                    values: {
                        rider: {
                            host: "127.0.0.2",
                            port: 9000,
                            database_path: "runtime/rider.db",
                            fit_file_dir: "runtime/fit",
                            strava_scopes: "activity:write"
                        },
                        training_agent: { host: "127.0.0.3", port: 9100 },
                        strava: { client_id: "client", client_secret: "secret" },
                        web_api_token: "shared-token"
                    }
                }, {});
                assertEqual(env.HOST, "127.0.0.2");
                assertEqual(env.PORT, "9000");
                assertEqual(env.PERSONAL_FIT_AGENT_URL, "http://127.0.0.3:9100");
                assertEqual(env.PERSONAL_FIT_AGENT_TOKEN, "shared-token");
                assertEqual(env.STRAVA_CLIENT_ID, undefined);
                assertEqual(env.RIDER_TRACKER_DB_PATH, path.join(root, "runtime", "rider.db"));
                assertEqual(env.TRAINING_AGENT_DB_PATH, path.join(root, "runtime", "rider.db"));
                assertEqual(env.TRAINING_AGENT_MANAGED_DATABASE, "1");
                assertEqual(env.TRAINING_AGENT_CONFIG_PATH, path.join(root, "config.yaml"));
            }
        },
        {
            name: "environment variables override YAML values",
            run() {
                const root = path.resolve("/tmp/rider-config-test");
                const env = buildRuntimeEnv(root, {
                    configPath: path.join(root, "config.yaml"),
                    values: { rider: { port: 9000 }, training_agent: { port: 9100 } }
                }, { PORT: "9999", PERSONAL_FIT_AGENT_URL: "http://127.0.0.1:9998" });
                assertEqual(env.PORT, "9999");
                assertEqual(env.PERSONAL_FIT_AGENT_URL, "http://127.0.0.1:9998");
                assertEqual(env.PERSONAL_FIT_AGENT_PORT, "9998");
            }
        },
        {
            name: "uses the unified Rider database when legacy config has no Rider section",
            run() {
                const root = path.resolve("/tmp/rider-config-test");
                const env = buildRuntimeEnv(root, {
                    configPath: path.join(root, "config.yaml"),
                    values: { download_count: 1 }
                }, {});
                const databasePath = path.join(root, "data", "rider-tracker.db");
                assertEqual(env.RIDER_TRACKER_DB_PATH, databasePath);
                assertEqual(env.TRAINING_AGENT_DB_PATH, databasePath);
                assertEqual(env.FIT_FILE_DIR, path.join(root, "data", "files", "fit"));
            }
        },
        {
            name: "explicit Agent port override also updates the generated URL",
            run() {
                const root = path.resolve("/tmp/rider-config-test");
                const env = buildRuntimeEnv(root, {
                    configPath: path.join(root, "config.yaml"),
                    values: { training_agent: { host: "127.0.0.3", port: 9100 } }
                }, { PERSONAL_FIT_AGENT_PORT: "9200" });
                assertEqual(env.PERSONAL_FIT_AGENT_URL, "http://127.0.0.3:9200");
            }
        }
    ]
};
