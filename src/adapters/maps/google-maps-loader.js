const GOOGLE_CALLBACK_NAME = "__riderTrackerGoogleMapsInit";
let googleMapsLoadPromise = null;

export function loadGoogleMapsApi(apiKey) {
    if (!apiKey) {
        return Promise.reject(new Error("缺少 Google Maps API Key"));
    }

    if (window.google?.maps?.ElevationService && window.google?.maps?.geometry) {
        return Promise.resolve();
    }

    if (googleMapsLoadPromise) {
        return googleMapsLoadPromise;
    }

    googleMapsLoadPromise = new Promise((resolve, reject) => {
        const previousAuthFailure = window.gm_authFailure;

        window.gm_authFailure = () => {
            cleanup();
            reject(new Error("API Key 验证失败，请检查 Key 与配额设置。"));
        };

        window[GOOGLE_CALLBACK_NAME] = () => {
            cleanup();
            resolve();
        };

        const script = document.createElement("script");
        script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=geometry&callback=${GOOGLE_CALLBACK_NAME}`;
        script.async = true;
        script.defer = true;
        script.onerror = () => {
            cleanup();
            reject(new Error("Google Maps API 加载失败，请检查网络连接或 API Key。"));
        };

        function cleanup() {
            if (window[GOOGLE_CALLBACK_NAME]) {
                delete window[GOOGLE_CALLBACK_NAME];
            }
            if (previousAuthFailure) {
                window.gm_authFailure = previousAuthFailure;
            } else if (window.gm_authFailure) {
                delete window.gm_authFailure;
            }
        }

        document.body.appendChild(script);
    }).catch((error) => {
        googleMapsLoadPromise = null;
        throw error;
    });

    return googleMapsLoadPromise;
}
