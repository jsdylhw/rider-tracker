const LEAFLET_VERSION = "1.9.4";
const RESOURCE_TIMEOUT_MS = 5000;

export const LEAFLET_CDN_PROVIDERS = [
    {
        name: "jsDelivr",
        baseUrl: `https://cdn.jsdelivr.net/npm/leaflet@${LEAFLET_VERSION}/dist`
    },
    {
        name: "unpkg",
        baseUrl: `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist`
    },
    {
        name: "staticfile",
        baseUrl: `https://cdn.staticfile.net/leaflet/${LEAFLET_VERSION}`
    }
];

/**
 * Loads Leaflet and its stylesheet from multiple CDNs. The map is optional for
 * the rest of the application, so a complete CDN outage must not stop startup.
 */
export async function ensureLeaflet() {
    if (globalThis.window?.L) return true;

    const documentRef = globalThis.document;
    if (!documentRef?.head) return false;

    const stylesheetLoaded = await loadFirstAvailableResource(
        LEAFLET_CDN_PROVIDERS.map((provider) => ({
            provider: provider.name,
            url: `${provider.baseUrl}/leaflet.css`
        })),
        loadStylesheet
    );
    const scriptLoaded = await loadFirstAvailableResource(
        LEAFLET_CDN_PROVIDERS.map((provider) => ({
            provider: provider.name,
            url: `${provider.baseUrl}/leaflet.js`
        })),
        loadScript
    );

    if (!stylesheetLoaded) {
        console.warn("Leaflet 样式加载失败，地图控件可能显示异常。");
    }
    if (!scriptLoaded || !globalThis.window?.L) {
        console.warn("Leaflet 加载失败，地图预览不可用。", globalThis.__leafletLoadError);
        return false;
    }

    return true;
}

async function loadFirstAvailableResource(candidates, load) {
    let lastError = null;

    for (const candidate of candidates) {
        try {
            await load(candidate.url);
            return true;
        } catch (error) {
            lastError = error;
            console.warn(`无法从 ${candidate.provider} 加载 Leaflet，尝试备用地址。`, error);
        }
    }

    globalThis.__leafletLoadError = lastError?.message ?? "所有 Leaflet CDN 均不可用";
    return false;
}

function loadStylesheet(url) {
    return loadElement("link", url, (element) => {
        element.rel = "stylesheet";
        element.href = url;
    });
}

function loadScript(url) {
    return loadElement("script", url, (element) => {
        element.src = url;
        element.async = true;
    });
}

function loadElement(tagName, url, configure) {
    return new Promise((resolve, reject) => {
        const element = globalThis.document.createElement(tagName);
        const timeoutId = globalThis.setTimeout(() => {
            element.remove();
            reject(new Error(`加载超时：${url}`));
        }, RESOURCE_TIMEOUT_MS);

        element.onload = () => {
            globalThis.clearTimeout(timeoutId);
            resolve();
        };
        element.onerror = () => {
            globalThis.clearTimeout(timeoutId);
            element.remove();
            reject(new Error(`加载失败：${url}`));
        };
        configure(element);
        globalThis.document.head.append(element);
    });
}
