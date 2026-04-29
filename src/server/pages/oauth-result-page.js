import { escapeHtml } from "../shared/http-utils.js";

export function buildOAuthResultPage({ title, message, payload = null }) {
    const safePayload = JSON.stringify(payload || { type: "rider-tracker:strava-error", message });
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #f3f5fb; color: #222f3e; }
    main { max-width: 520px; padding: 28px; background: #fff; border: 1px solid #dfe4ea; border-radius: 14px; box-shadow: 0 18px 45px rgba(15, 23, 42, 0.08); }
    h1 { margin: 0 0 10px; font-size: 24px; }
    p { margin: 0; color: #64748b; line-height: 1.6; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </main>
  <script>
    const payload = ${safePayload};
    if (window.opener) {
      window.opener.postMessage(payload, window.location.origin);
      window.setTimeout(() => window.close(), 800);
    }
  </script>
</body>
</html>`;
}

export function sendOAuthResultPage(res, { ok, title, message, payload = null }) {
    res.status(ok ? 200 : 400).type("html").send(buildOAuthResultPage({
        title,
        message,
        payload
    }));
}
