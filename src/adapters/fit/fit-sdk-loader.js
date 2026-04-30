const FIT_SDK_URLS = [
    "@garmin/fitsdk",
    "/vendor/@garmin/fitsdk/src/index.js",
    "https://esm.sh/@garmin/fitsdk@21.178.0/es2022/fitsdk.mjs",
    "https://cdn.jsdelivr.net/npm/@garmin/fitsdk@21.178.0/es2022/fitsdk.mjs"
];

let fitSdkPromise;

export async function loadFitSdk() {
    if (!fitSdkPromise) {
        fitSdkPromise = loadFirstAvailableFitSdk();
    }

    return fitSdkPromise;
}

async function loadFirstAvailableFitSdk() {
    const errors = [];
    for (const url of FIT_SDK_URLS) {
        try {
            return await import(url);
        } catch (err) {
            errors.push(err);
        }
    }
    const message = errors.map((err) => (err instanceof Error ? err.message : String(err))).filter(Boolean).join(" | ");
    throw new Error(`加载 FIT SDK 失败：${message || "未知错误"}`);
}
