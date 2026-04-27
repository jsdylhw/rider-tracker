import { uploadFitToEndpoint } from "./fit-upload-client.js";

const DEFAULT_STRAVA_SERVER_URL = "http://localhost:8787";
const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_MAX_POLL_ATTEMPTS = 24;

export function getDefaultStravaServerUrl() {
    return getCurrentOrigin() || DEFAULT_STRAVA_SERVER_URL;
}

export async function startStravaAuthorization({ serverUrl, userId }) {
    const baseUrl = normalizeServerUrl(serverUrl);
    const url = new URL(`${baseUrl}/api/strava/auth/start`);
    if (userId) url.searchParams.set("userId", userId);

    const response = await fetch(url.toString());
    const body = await safeReadJson(response);
    if (!response.ok || body?.ok === false) {
        throw new Error(buildServerErrorMessage(response, body, "Strava authorization"));
    }

    if (!body?.authUrl) {
        throw new Error("Strava server did not return an authorization URL.");
    }

    return body;
}

export async function getStravaConnection({ serverUrl, userId }) {
    const baseUrl = normalizeServerUrl(serverUrl);
    const url = new URL(`${baseUrl}/api/strava/connection`);
    if (userId) url.searchParams.set("userId", userId);

    const response = await fetch(url.toString());
    const body = await safeReadJson(response);
    if (!response.ok || body?.ok === false) {
        throw new Error(buildServerErrorMessage(response, body, "Strava connection"));
    }

    return body;
}

export async function getStravaServerConfig({ serverUrl }) {
    const baseUrl = normalizeServerUrl(serverUrl);
    const response = await fetch(`${baseUrl}/api/strava/config`);
    const body = await safeReadJson(response);
    if (!response.ok || body?.ok === false) {
        throw new Error(buildServerErrorMessage(response, body, "Strava config"));
    }

    return body;
}

export async function uploadFitToStravaServer({
    serverUrl,
    userId,
    fitBytes,
    filename,
    activityName,
    fitDescription,
    repositoryUrl,
    generatedMessage,
    trainer = true,
    commute = false,
    externalId,
    sportType = "VirtualRide",
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    maxPollAttempts = DEFAULT_MAX_POLL_ATTEMPTS
}) {
    const baseUrl = normalizeServerUrl(serverUrl);
    const uploadResponse = await uploadFitToEndpoint({
        endpointUrl: `${baseUrl}/api/strava/upload-fit`,
        fitBytes,
        filename,
        activityName,
        fitDescription,
        repositoryUrl,
        generatedMessage,
        userId: userId || "default",
        trainer,
        commute,
        externalId,
        sportType
    });

    if (uploadResponse?.ok === false) {
        throw new Error(uploadResponse.error || "Strava server upload failed.");
    }

    const upload = uploadResponse?.upload ?? uploadResponse;
    const uploadId = upload?.id_str ?? upload?.id;
    if (!uploadId) {
        throw new Error("Strava server did not return an upload id.");
    }

    return pollStravaUploadStatus({
        baseUrl,
        userId: userId || "default",
        uploadId,
        pollIntervalMs,
        maxPollAttempts
    });
}

async function pollStravaUploadStatus({
    baseUrl,
    userId,
    uploadId,
    pollIntervalMs,
    maxPollAttempts
}) {
    let latestStatus = null;

    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
        if (attempt > 0) {
            await delay(pollIntervalMs);
        }

        latestStatus = await getStravaUploadStatus({ baseUrl, userId, uploadId });

        if (latestStatus?.activity_id) {
            return latestStatus;
        }

        if (latestStatus?.error) {
            throw new Error(`Strava processing failed: ${latestStatus.error}`);
        }
    }

    const status = latestStatus?.status ? ` Last status: ${latestStatus.status}` : "";
    throw new Error(`Strava upload is still processing.${status}`);
}

async function getStravaUploadStatus({ baseUrl, userId, uploadId }) {
    const url = new URL(`${baseUrl}/api/strava/upload-status/${encodeURIComponent(uploadId)}`);
    if (userId) url.searchParams.set("userId", userId);

    const response = await fetch(url.toString());
    const body = await safeReadJson(response);

    if (!response.ok || body?.ok === false) {
        throw new Error(buildServerErrorMessage(response, body, "Strava upload status"));
    }

    return body?.status ?? body;
}

function normalizeServerUrl(serverUrl) {
    const fallback = getDefaultStravaServerUrl();
    return String(serverUrl || fallback).trim().replace(/\/+$/, "") || fallback;
}

function getCurrentOrigin() {
    return globalThis.location?.origin || "";
}

function buildServerErrorMessage(response, body, actionLabel) {
    const message = body?.error || body?.message || response.statusText || "Unknown error";
    return `${actionLabel} failed (${response.status}): ${message}`;
}

async function safeReadJson(response) {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

function delay(ms) {
    return new Promise((resolve) => {
        window.setTimeout(resolve, ms);
    });
}
