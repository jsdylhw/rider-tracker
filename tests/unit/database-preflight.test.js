import path from "node:path";
import { ensureManagedDatabase } from "../../scripts/database-preflight.js";
import { assert, assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "database-preflight",
    tests: [
        {
            name: "runs the idempotent database ensure operation before startup",
            run() {
                let invocation = null;
                ensureManagedDatabase({
                    python: "python-test",
                    projectRoot: "/rider",
                    env: { TEST_ENV: "1" },
                    databaseReadyImpl: () => false,
                    spawnImpl(command, args, options) {
                        invocation = { command, args, options };
                        return { status: 0, stdout: "", stderr: "" };
                    }
                });

                assertEqual(invocation.command, "python-test");
                assertEqual(invocation.args[0], path.join("/rider", "scripts", "database-tool.py"));
                assertEqual(invocation.args[1], "ensure");
                assertEqual(invocation.args[2], "--quiet");
                assertEqual(invocation.options.cwd, "/rider");
            }
        },
        {
            name: "stops startup with the database tool diagnostic",
            run() {
                let error = null;
                try {
                    ensureManagedDatabase({
                        python: "python-test",
                        projectRoot: "/rider",
                        databaseReadyImpl: () => false,
                        spawnImpl: () => ({ status: 1, stdout: "", stderr: "migration failed" })
                    });
                } catch (caught) {
                    error = caught;
                }
                assert(Boolean(error));
                assertEqual(error.message, "migration failed");
            }
        },
        {
            name: "does not require Python when the managed database is already ready",
            run() {
                let spawnCount = 0;
                ensureManagedDatabase({
                    python: "missing-python",
                    projectRoot: "/rider",
                    databaseReadyImpl: () => true,
                    spawnImpl: () => {
                        spawnCount += 1;
                        return { status: 1 };
                    }
                });

                assertEqual(spawnCount, 0);
            }
        }
    ]
};
