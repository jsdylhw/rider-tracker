export async function saveRiderSessionActivity(session, {
    serverUrl = globalThis.location?.origin || "",
    name = session?.exportMetadata?.activityName,
    sportType
} = {}) {
    if (!session || !serverUrl) {
        return null;
    }

    const response = await fetch(`${serverUrl}/api/activities/rider-session`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            session,
            name,
            sportType
        })
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) {
        throw new Error(body?.error || "Activity history save failed.");
    }

    return body.activity;
}

export async function listActivities({
    serverUrl = globalThis.location?.origin || "",
    limit = 50
} = {}) {
    const history = await fetchActivityHistory({ serverUrl, limit });
    return history.activities;
}

export async function fetchActivityHistory({
    serverUrl = globalThis.location?.origin || "",
    limit = 50,
    offset = 0,
    sportType = "",
    source = ""
} = {}) {
    if (!serverUrl) {
        return { activities: [], summary: {}, page: { total: 0, offset: 0, limit, hasMore: false } };
    }

    const url = new URL(`${serverUrl}/api/activities`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    if (sportType) url.searchParams.set("sportType", sportType);
    if (source) url.searchParams.set("source", source);
    const response = await fetch(url);
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) {
        throw new Error(body?.error || "Activity history fetch failed.");
    }

    return {
        activities: body.activities ?? [],
        summary: body.summary ?? {},
        page: body.page ?? { total: body.activities?.length ?? 0, offset, limit, hasMore: false }
    };
}

export async function renameActivity(activityId, name, {
    serverUrl = globalThis.location?.origin || ""
} = {}) {
    if (!activityId || !serverUrl) {
        return null;
    }

    const response = await fetch(`${serverUrl}/api/activities/${encodeURIComponent(activityId)}`, {
        method: "PATCH",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ name })
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) {
        throw new Error(body?.error || "Activity rename failed.");
    }

    return body.activity;
}

export async function getActivity(activityId, {
    serverUrl = globalThis.location?.origin || ""
} = {}) {
    if (!activityId || !serverUrl) {
        return null;
    }

    const response = await fetch(`${serverUrl}/api/activities/${encodeURIComponent(activityId)}`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) {
        throw new Error(body?.error || "Activity fetch failed.");
    }

    return body.activity;
}

export async function saveActivityFitFile(activityId, {
    fitBytes,
    filename,
    serverUrl = globalThis.location?.origin || ""
} = {}) {
    if (!activityId || !fitBytes || !serverUrl) {
        return null;
    }

    const payload = fitBytes instanceof Uint8Array ? fitBytes : new Uint8Array(fitBytes);
    const fitBlob = new Blob([payload], { type: "application/vnd.ant.fit" });
    const formData = new FormData();
    formData.append("file", fitBlob, filename || `${activityId}.fit`);

    const response = await fetch(`${serverUrl}/api/activities/${encodeURIComponent(activityId)}/fit`, {
        method: "POST",
        body: formData
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) {
        throw new Error(body?.error || "Activity FIT save failed.");
    }

    return body.activity;
}

export async function importActivityFitFile({
    fitBytes,
    filename,
    session = null,
    name = session?.exportMetadata?.activityName,
    sportType = "Ride",
    serverUrl = globalThis.location?.origin || ""
} = {}) {
    if (!fitBytes || !serverUrl) {
        return null;
    }

    const payload = fitBytes instanceof Uint8Array ? fitBytes : new Uint8Array(fitBytes);
    const fitBlob = new Blob([payload], { type: "application/vnd.ant.fit" });
    const formData = new FormData();
    formData.append("file", fitBlob, filename || "activity.fit");
    if (session) formData.append("session", JSON.stringify(session));
    if (name) formData.append("name", name);
    if (sportType) formData.append("sportType", sportType);

    const response = await fetch(`${serverUrl}/api/activities/fit-import`, {
        method: "POST",
        body: formData
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) {
        throw new Error(body?.error || "Activity FIT import save failed.");
    }

    return body.activity;
}

export async function deleteActivity(activityId, {
    serverUrl = globalThis.location?.origin || ""
} = {}) {
    if (!activityId || !serverUrl) {
        return null;
    }

    const response = await fetch(`${serverUrl}/api/activities/${encodeURIComponent(activityId)}`, {
        method: "DELETE"
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) {
        throw new Error(body?.error || "Activity delete failed.");
    }

    return body.activity;
}
