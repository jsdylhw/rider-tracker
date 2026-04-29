export function normalizeUserId(value) {
    const text = String(value || "").trim();
    return text || "default";
}

export function normalizeFileToken(value) {
    const text = normalizeText(value);
    return (text || "file")
        .replaceAll(/\s+/g, "-")
        .replaceAll(/[^a-zA-Z0-9._-]/g, "")
        .slice(0, 120) || "file";
}

export function normalizeText(value) {
    const text = String(value || "").trim();
    return text || "";
}

export function parseBoolean(value) {
    if (typeof value === "boolean") return value;
    const normalized = String(value || "").toLowerCase();
    if (!normalized) return undefined;
    return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function escapeHtml(value) {
    return String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
