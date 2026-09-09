import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { buildRuntimeEnv, loadUnifiedConfig } from "./local-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });
const runtimeEnv = buildRuntimeEnv(projectRoot, loadUnifiedConfig(projectRoot), process.env);
const child = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    path.join(projectRoot, "src", "server", "index.js")
], { cwd: projectRoot, env: runtimeEnv, stdio: "inherit" });

child.once("error", (error) => {
    console.error(`[rider-tracker] failed to start: ${error.message}`);
    process.exitCode = 1;
});
child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code || 0);
});
process.on("SIGINT", () => child.kill());
process.on("SIGTERM", () => child.kill());
