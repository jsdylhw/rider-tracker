import { openBrowser, shouldOpenBrowser } from "../../scripts/browser-launcher.js";
import { assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "browser-launcher",
    tests: [
        {
            name: "missing browser opener gives a manual URL without raw spawn errors",
            run() {
                let onError;
                let message;
                openBrowser("http://localhost:8787", {
                    platform: "linux", env: { DISPLAY: ":0" },
                    warn(value) { message = value; },
                    spawnImpl() {
                        return { once(event, callback) { if (event === "error") onError = callback; }, unref() {} };
                    }
                });
                onError(Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }));
                assertEqual(message.includes("http://localhost:8787"), true);
                assertEqual(message.includes("服务不受影响"), true);
                assertEqual(message.includes("ENOENT"), false);
            }
        },
        {
            name: "opens only the Rider public URL on a desktop session",
            run() {
                let invocation = null;
                const result = openBrowser("http://localhost:8787", {
                    platform: "linux",
                    env: { DISPLAY: ":0" },
                    spawnImpl(command, args, options) {
                        invocation = { command, args, options };
                        return { once() {}, unref() {} };
                    }
                });

                assertEqual(result.opened, true);
                assertEqual(invocation.command, "xdg-open");
                assertEqual(invocation.args.join(" "), "http://localhost:8787");
            }
        },
        {
            name: "skips browser launch when disabled or headless",
            run() {
                assertEqual(shouldOpenBrowser("false"), false);
                assertEqual(shouldOpenBrowser(undefined), true);
                const result = openBrowser("http://localhost:8787", {
                    platform: "linux", env: {}, spawnImpl() { throw new Error("must not spawn"); }
                });
                assertEqual(result.opened, false);
                assertEqual(result.reason, "no_desktop_session");
            }
        }
    ]
};
