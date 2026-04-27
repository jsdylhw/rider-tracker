const configForm = document.getElementById("configForm");
const uploadForm = document.getElementById("uploadForm");
const connectBtn = document.getElementById("connectBtn");
const refreshStatusBtn = document.getElementById("refreshStatusBtn");
const configPath = document.getElementById("configPath");
const redirectUri = document.getElementById("redirectUri");
const scopes = document.getElementById("scopes");
const connectionText = document.getElementById("connectionText");
const uploadText = document.getElementById("uploadText");
const resultOutput = document.getElementById("resultOutput");

const POLL_INTERVAL_MS = 1500;
const MAX_POLL_ATTEMPTS = 30;

refreshConfig();

configForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(configForm);

    setStatus(connectionText, "正在保存配置...");
    try {
        const body = await postJson("/api/config", {
            clientId: form.get("clientId"),
            clientSecret: form.get("clientSecret")
        });
        renderConfig(body);
        configForm.reset();
        setStatus(connectionText, "配置已保存，可以连接 Strava。", "ok");
    } catch (error) {
        setStatus(connectionText, `保存失败：${getErrorMessage(error)}`, "error");
    }
});

connectBtn.addEventListener("click", async () => {
    setStatus(connectionText, "正在创建 Strava 授权链接...");
    try {
        const body = await readJson(await fetch("/api/auth/start"));
        window.open(body.authUrl, "_blank", "noopener,noreferrer");
        setStatus(connectionText, "授权页面已打开。完成授权后回到这里点击刷新状态。", "ok");
    } catch (error) {
        setStatus(connectionText, `授权启动失败：${getErrorMessage(error)}`, "error");
    }
});

refreshStatusBtn.addEventListener("click", refreshConfig);

uploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(uploadForm);
    const file = form.get("file");

    if (!file || file.size === 0) {
        setStatus(uploadText, "请选择 FIT 文件。", "error");
        return;
    }

    if (!form.get("externalId")) {
        form.set("externalId", buildExternalId(file));
    }

    setStatus(uploadText, "正在上传 FIT 到 Strava...");
    renderResult({});

    try {
        const uploadResponse = await readJson(await fetch("/api/upload-fit", {
            method: "POST",
            body: form
        }));
        renderResult(uploadResponse);

        const upload = uploadResponse.upload;
        const uploadId = upload?.id_str || upload?.id;
        if (!uploadId) {
            setStatus(uploadText, "上传已提交，但 Strava 没有返回 upload id。", "error");
            return;
        }

        setStatus(uploadText, `上传已提交，upload id: ${uploadId}。正在等待 Strava 处理...`, "ok");
        const finalStatus = await pollUploadStatus(uploadId);
        renderResult({ upload, finalStatus });

        if (finalStatus.activity_id) {
            setStatus(uploadText, `Strava 处理完成，activity id: ${finalStatus.activity_id}。`, "ok");
        } else {
            setStatus(uploadText, `Strava 仍在处理。最后状态：${finalStatus.status || "unknown"}`, "warn");
        }
    } catch (error) {
        setStatus(uploadText, `上传失败：${getErrorMessage(error)}`, "error");
    }
});

async function refreshConfig() {
    try {
        const body = await readJson(await fetch("/api/config"));
        renderConfig(body);
    } catch (error) {
        setStatus(connectionText, `读取配置失败：${getErrorMessage(error)}`, "error");
    }
}

function renderConfig(config) {
    configPath.textContent = config.configPath || "--";
    redirectUri.textContent = config.redirectUri || "--";
    scopes.textContent = config.scopes || "--";

    if (!config.hasClientId || !config.hasClientSecret) {
        setStatus(connectionText, "请先保存 Strava Client ID 和 Client Secret。", "warn");
        return;
    }

    if (config.connected) {
        const athlete = config.athlete
            ? `${config.athlete.firstname || ""} ${config.athlete.lastname || ""}`.trim()
            : "已授权账号";
        setStatus(connectionText, `已连接：${athlete || "Strava"}。`, "ok");
        return;
    }

    setStatus(connectionText, "配置已保存，尚未完成 Strava 授权。", "warn");
}

async function pollUploadStatus(uploadId) {
    let latest = null;
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
        if (attempt > 0) {
            await delay(POLL_INTERVAL_MS);
        }

        const body = await readJson(await fetch(`/api/uploads/${encodeURIComponent(uploadId)}`));
        latest = body.status;
        renderResult({ uploadId, latestStatus: latest, attempt: attempt + 1 });

        if (latest?.activity_id || latest?.error) {
            return latest;
        }
    }
    return latest || {};
}

async function postJson(url, body) {
    return readJson(await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    }));
}

async function readJson(response) {
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.ok === false) {
        throw new Error(body?.error || body?.message || response.statusText || "Request failed");
    }
    return body;
}

function renderResult(value) {
    resultOutput.textContent = JSON.stringify(value, null, 2);
}

function setStatus(element, text, kind = "") {
    element.textContent = text;
    element.dataset.kind = kind;
}

function buildExternalId(file) {
    const safeName = String(file.name || "ride.fit").replaceAll(/[^a-zA-Z0-9._-]/g, "-");
    return `rider-tracker-demo-${Date.now()}-${safeName}`;
}

function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}
