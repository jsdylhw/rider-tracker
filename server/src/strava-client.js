const STRAVA_OAUTH_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_OAUTH_AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";
const STRAVA_UPLOAD_URL = "https://www.strava.com/api/v3/uploads";
const STRAVA_API_BASE_URL = "https://www.strava.com/api/v3";

export function createStravaClient({ clientId, clientSecret, redirectUri, scopes }) {
    function buildAuthorizeUrl({ state }) {
        const query = new URLSearchParams({
            client_id: String(clientId),
            redirect_uri: redirectUri,
            response_type: "code",
            approval_prompt: "auto",
            scope: scopes
        });

        if (state) {
            query.set("state", state);
        }

        return `${STRAVA_OAUTH_AUTHORIZE_URL}?${query.toString()}`;
    }

    async function exchangeCode(code) {
        const payload = new URLSearchParams({
            client_id: String(clientId),
            client_secret: clientSecret,
            code,
            grant_type: "authorization_code"
        });

        return requestToken(payload);
    }

    async function refreshToken(refreshToken) {
        const payload = new URLSearchParams({
            client_id: String(clientId),
            client_secret: clientSecret,
            grant_type: "refresh_token",
            refresh_token: refreshToken
        });

        return requestToken(payload);
    }

    async function createUpload({ accessToken, fileBlob, filename, dataType, name, description, trainer, commute, externalId, sportType }) {
        const body = new FormData();
        body.append("file", fileBlob, filename);
        body.append("data_type", dataType);

        if (name) body.append("name", name);
        if (description) body.append("description", description);
        if (typeof trainer === "boolean") body.append("trainer", trainer ? "1" : "0");
        if (typeof commute === "boolean") body.append("commute", commute ? "1" : "0");
        if (externalId) body.append("external_id", externalId);
        if (sportType) body.append("sport_type", sportType);

        const response = await fetch(STRAVA_UPLOAD_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${accessToken}`
            },
            body
        });

        return parseJsonResponse(response, "Strava 上传");
    }

    async function getUploadStatus({ accessToken, uploadId }) {
        const response = await fetch(`${STRAVA_API_BASE_URL}/uploads/${uploadId}`, {
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        });

        return parseJsonResponse(response, "Strava 上传状态");
    }

    async function requestToken(payload) {
        const response = await fetch(STRAVA_OAUTH_TOKEN_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: payload.toString()
        });

        return parseJsonResponse(response, "Strava Token");
    }

    return {
        buildAuthorizeUrl,
        exchangeCode,
        refreshToken,
        createUpload,
        getUploadStatus
    };
}

async function parseJsonResponse(response, actionLabel) {
    const text = await response.text();
    let data = null;

    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { message: text };
    }

    if (!response.ok) {
        const errorMessage = typeof data?.message === "string" ? data.message : JSON.stringify(data);
        throw new Error(`${actionLabel}失败（${response.status}）：${errorMessage}`);
    }

    return data;
}
