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
    if (!serverUrl) {
        return [];
    }

    const url = new URL(`${serverUrl}/api/activities`);
    url.searchParams.set("limit", String(limit));
    const response = await fetch(url);
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) {
        throw new Error(body?.error || "Activity history fetch failed.");
    }

    return body.activities ?? [];
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
