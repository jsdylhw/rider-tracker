import { buildAllowedLocalOrigins, buildLocalBaseUrl, createLocalApiOriginGuard } from "../../src/server/local-api-security.js";
import { assertEqual } from "../helpers/test-harness.js";

function runGuard(guard, origin) {
    const result = { nextCalls: 0, status: null, body: null };
    guard({
        headers: origin ? { origin } : {},
        get(name) {
            return name === "origin" ? origin : undefined;
        }
    }, {
        status(code) {
            result.status = code;
            return this;
        },
        json(body) {
            result.body = body;
        }
    }, () => {
        result.nextCalls += 1;
    });
    return result;
}

export const suite = {
    name: "local-api-security",
    tests: [
        {
            name: "仅允许本地应用来源访问 API",
            run() {
                const allowedOrigins = buildAllowedLocalOrigins({
                    host: "127.0.0.1",
                    port: 8787,
                    appBaseUrl: "http://localhost:8787"
                });
                const guard = createLocalApiOriginGuard({ allowedOrigins });

                assertEqual(runGuard(guard, "http://localhost:8787").nextCalls, 1);
                assertEqual(runGuard(guard, "http://malicious.example").status, 403);
                assertEqual(runGuard(guard, "http://malicious.example").body.ok, false);
                assertEqual(runGuard(guard, null).nextCalls, 1);
            }
        },
        {
            name: "IPv6 本地来源使用带方括号的 URL",
            run() {
                const appBaseUrl = buildLocalBaseUrl({ host: "::1", port: 8787 });
                const allowedOrigins = buildAllowedLocalOrigins({
                    host: "::1",
                    port: 8787,
                    appBaseUrl
                });
                const guard = createLocalApiOriginGuard({ allowedOrigins });

                assertEqual(appBaseUrl, "http://[::1]:8787");
                assertEqual(runGuard(guard, "http://[::1]:8787").nextCalls, 1);
                assertEqual(runGuard(guard, "http://[::2]:8787").status, 403);
            }
        }
    ]
};
