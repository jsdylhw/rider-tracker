const DEFAULT_UPLOAD_FIELD_NAME = "file";

export async function uploadFitToEndpoint({
    endpointUrl,
    fitBytes,
    filename,
    activityName,
    fitDescription,
    repositoryUrl,
    generatedMessage
}) {
    const formData = new FormData();
    const payload = fitBytes instanceof Uint8Array ? fitBytes : new Uint8Array(fitBytes);
    const fitBlob = new Blob([payload], { type: "application/vnd.ant.fit" });
    formData.append(DEFAULT_UPLOAD_FIELD_NAME, fitBlob, filename);
    formData.append("message", generatedMessage);
    formData.append("activityName", activityName);
    formData.append("fitDescription", fitDescription);
    formData.append("repositoryUrl", repositoryUrl);

    const response = await fetch(endpointUrl, {
        method: "POST",
        body: formData
    });

    if (!response.ok) {
        const text = await safeReadText(response);
        throw new Error(`上传失败（${response.status}）：${text || response.statusText || "未知错误"}`);
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
