import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertEqual } from "../helpers/test-harness.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
function runFixture(config) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "rider-doctor-test-"));
    try {
        const configPath = path.join(dir, "config.yaml");
        writeFileSync(configPath, config);
        const result = spawnSync(process.execPath, [path.join(root, "scripts/doctor.js"), "--json"], {
            cwd: root, encoding: "utf8", env: { ...process.env,
                RIDER_ENV_PATH: path.join(dir, "absent.env"), RIDER_CONFIG_PATH: configPath,
                PYTHON_EXECUTABLE: path.join(dir, "missing-python-executable")
            }
        });
        assertEqual(result.status, 1);
        assertEqual(result.stdout.includes("sentinel-private"), false);
        assertEqual(result.stderr.includes("sentinel-private"), false);
        return JSON.parse(result.stdout);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
export const suite = {
    name: "runtime-doctor",
    tests: [
        { name: "doctor reports missing Python as structured failure", run() {
            const report = runFixture("agent:\n  api_key: sentinel-private-key\n");
            assertEqual(report.ok, false);
            assertEqual(report.checks[0].id, "python");
        } },
        { name: "doctor YAML errors never echo credential source lines", run() {
            const report = runFixture("agent: [sentinel-private-key\n");
            assertEqual(report.ok, false);
            assertEqual(report.checks[0].id, "config");
        } }
    ]
};
