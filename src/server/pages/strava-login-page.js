import { escapeHtml } from "../shared/http-utils.js";

export function buildStravaLoginPage({ userId, configured, hasEnvCredentials, redirectUri, scopes, configPath }) {
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Strava Login - Rider Tracker</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #f3f5fb; color: #222f3e; }
    main { width: min(680px, calc(100vw - 32px)); padding: 28px; background: #fff; border: 1px solid #dfe4ea; border-radius: 14px; box-shadow: 0 18px 45px rgba(15, 23, 42, 0.08); }
    h1 { margin: 0 0 8px; font-size: 26px; }
    p { color: #64748b; line-height: 1.6; }
    form { display: grid; gap: 14px; margin-top: 18px; }
    label { display: grid; gap: 6px; color: #64748b; font-size: 13px; font-weight: 700; }
    input { border: 1px solid #dfe4ea; border-radius: 10px; padding: 11px 12px; font-size: 15px; }
    button { border: 0; border-radius: 10px; padding: 12px 16px; background: #fc4c02; color: #fff; font-weight: 800; cursor: pointer; }
    button.secondary { background: #3742fa; }
    dl { display: grid; gap: 8px; padding: 12px; background: #f8fafc; border: 1px solid #dfe4ea; border-radius: 12px; }
    div.row { display: grid; grid-template-columns: 110px 1fr; gap: 10px; font-size: 13px; }
    dt { color: #64748b; font-weight: 800; }
    dd { margin: 0; word-break: break-all; }
    #status { min-height: 24px; font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <h1>连接 Strava</h1>
    <p>Strava 凭据与 Token 由内嵌 Training Agent 统一管理。</p>
    <dl>
      <div class="row"><dt>Callback</dt><dd>${escapeHtml(redirectUri)}</dd></div>
      <div class="row"><dt>Scopes</dt><dd>${escapeHtml(scopes)}</dd></div>
      <div class="row"><dt>Config</dt><dd>${escapeHtml(configPath)}</dd></div>
    </dl>
    ${configured || hasEnvCredentials
        ? `<p id="status">已从统一配置读取 Strava 凭据。</p><button id="connectBtn" class="secondary" type="button">继续授权 Strava</button>`
        : `<p id="status">请在 config.yaml 的 strava 区块配置 client_id 和 client_secret，然后重启 Rider。</p>`}
  </main>
  <script>
    const userId = ${JSON.stringify(userId)};
    const connectBtn = document.getElementById("connectBtn");
    const statusEl = document.getElementById("status");

    async function connect() {
      statusEl.textContent = "正在创建 Strava 授权链接...";
      const response = await fetch("/api/strava/auth/start?userId=" + encodeURIComponent(userId));
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.ok === false) {
        throw new Error(body?.error || response.statusText || "Failed to start Strava authorization.");
      }
      window.location.href = body.authUrl;
    }

    if (connectBtn) {
      connectBtn.addEventListener("click", () => connect().catch((error) => {
        statusEl.textContent = error.message;
      }));
    }

  </script>
</body>
</html>`;
}
