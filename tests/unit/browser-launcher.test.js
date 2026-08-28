import { openBrowser, shouldOpenBrowser } from "../../scripts/browser-launcher.js";
import { assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "browser-launcher",
    tests: [
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
