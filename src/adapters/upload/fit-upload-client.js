const DEFAULT_UPLOAD_FIELD_NAME = "file";

export async function uploadFitToEndpoint({
    endpointUrl,
    fitBytes,
    filename,
    activityName,
    fitDescription,
    repositoryUrl,
    generatedMessage,
    userId,
    trainer,
    commute,
    externalId,
    sportType
}) {
    const formData = new FormData();
    const payload = fitBytes instanceof Uint8Array ? fitBytes : new Uint8Array(fitBytes);
    const fitBlob = new Blob([payload], { type: "application/vnd.ant.fit" });
    formData.append(DEFAULT_UPLOAD_FIELD_NAME, fitBlob, filename);
    formData.append("message", generatedMessage);
    formData.append("activityName", activityName);
    formData.append("fitDescription", fitDescription);
    formData.append("repositoryUrl", repositoryUrl);
    if (userId) formData.append("userId", String(userId));
    if (typeof trainer === "boolean") formData.append("trainer", trainer ? "1" : "0");
    if (typeof commute === "boolean") formData.append("commute", commute ? "1" : "0");
    if (externalId) formData.append("externalId", String(externalId));
    if (sportType) formData.append("sportType", String(sportType));

    const response = await fetch(endpointUrl, {
        method: "POST",
        body: formData
    });

    if (!response.ok) {
        const text = await safeReadText(response);
        throw new Error(`Upload failed (${response.status}): ${text || response.statusText || "Unknown error"}`);
    }

    return safeReadJson(response);
}

async function safeReadText(response) {
    try {
        return await response.text();
    } catch {
        return "";
    }
}

async function safeReadJson(response) {
    try {
        return await response.json();
    } catch {
        return null;
    }
}
