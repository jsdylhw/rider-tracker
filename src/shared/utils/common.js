export function clamp(value, min, max, fallback) {
    const parsed = Number(value);
    if (Number.isNaN(parsed)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
}

export function normalizeText(value, fallback, maxLength) {
    const text = String(value ?? "").trim();
    return (text || fallback).slice(0, maxLength);
}

export function extractErrorMessage(error) {
    if (error?.cause?.cause?.message) {
        return error.cause.cause.message;
    }
    if (error?.cause?.message) {
        return error.cause.message;
    }
    if (error?.message) {
        return error.message;
    }
    return "未知错误";
}