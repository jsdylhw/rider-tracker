import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { buildRuntimeEnv, loadUnifiedConfig } from "./local-config.js";
import { resolvePythonExecutable, trainingAgentRoot } from "./python-runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const agentRoot = trainingAgentRoot(projectRoot);
dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });
const runtimeEnv = buildRuntimeEnv(projectRoot, loadUnifiedConfig(projectRoot), process.env);
const python = resolvePythonExecutable(projectRoot, runtimeEnv);
const args = process.argv.slice(2);

if (args.length === 0) {
    console.error("Usage: npm run agent:cli -- <command> [arguments]");
    process.exit(2);
}

const result = spawnSync(python, ["-m", "app.cli", ...args], {
    cwd: agentRoot,
    env: { ...runtimeEnv, PYTHONPATH: agentRoot },
    stdio: "inherit"
});
if (result.error) throw result.error;
process.exit(result.status || 0);
