export function createLocalApiOriginGuard({ allowedOrigins }) {
    const origins = new Set(allowedOrigins ?? []);

    return (req, res, next) => {
        const origin = req.get?.("origin") ?? req.headers?.origin;
        if (!origin || origins.has(origin)) {
            next();
            return;
        }

        res.status(403).json({
            ok: false,
            error: "Cross-origin local API access is not allowed."
        });
    };
}

export function buildAllowedLocalOrigins({ host, port, appBaseUrl }) {
    const origins = new Set([
        buildLocalBaseUrl({ host: "localhost", port }),
        buildLocalBaseUrl({ host: "127.0.0.1", port }),
        buildLocalBaseUrl({ host, port })
    ]);

    try {
        origins.add(new URL(appBaseUrl).origin);
    } catch {
        // 环境变量格式无效时仍保留本地默认来源。
    }

    return origins;
}

export function buildLocalBaseUrl({ host, port }) {
    const normalizedHost = String(host ?? "").replace(/^\[|\]$/g, "");
    const hostForUrl = normalizedHost.includes(":") ? `[${normalizedHost}]` : normalizedHost;
    return `http://${hostForUrl}:${port}`;
}
