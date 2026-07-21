export function createGoogleMapsServiceModal({ elements, googleMapsConfig, reloadPage = reloadBrowserPage }) {
    let pendingResolve = null;

    function requestApiKey({ featureLabel, force = false }) {
        const config = googleMapsConfig?.getConfig?.();
        if (config?.apiKey && !force) {
            return Promise.resolve(config.apiKey);
        }
        if (!elements.googleMapsServiceOverlay) {
            return Promise.resolve("");
        }

        elements.googleMapsServiceTitle.textContent = `${featureLabel}需要 Google Maps API Key`;
        const isApiKeyLocked = config?.apiKeyLocked === true;
        elements.googleMapsServiceDescription.textContent = isApiKeyLocked
            ? "Google Maps 已使用当前 Key 初始化。输入新 Key 后将自动刷新页面以生效。"
            : "Key 仅保存在当前浏览器会话中，用于本次请求。";
        elements.googleMapsServiceStatus.textContent = "";
        elements.googleMapsServiceApiKeyInput.value = config?.apiKey ?? "";
        if (elements.confirmGoogleMapsServiceBtn) {
            elements.confirmGoogleMapsServiceBtn.textContent = isApiKeyLocked ? "更换 Key 并刷新" : "继续";
        }
        elements.googleMapsServiceOverlay.classList.add("open");
        elements.googleMapsServiceOverlay.setAttribute("aria-hidden", "false");
        elements.googleMapsServiceApiKeyInput.focus();

        return new Promise((resolve) => {
            pendingResolve?.("");
            pendingResolve = resolve;
        });
    }

    function close(value = "") {
        elements.googleMapsServiceOverlay?.classList.remove("open");
        elements.googleMapsServiceOverlay?.setAttribute("aria-hidden", "true");
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve?.(value);
    }

    function confirm() {
        const apiKey = elements.googleMapsServiceApiKeyInput?.value?.trim() ?? "";
        if (!apiKey) {
            elements.googleMapsServiceStatus.textContent = "请填写 Google Maps API Key。";
            return;
        }
        try {
            const config = googleMapsConfig?.getConfig?.();
            if (config?.apiKeyLocked && apiKey !== config.apiKey) {
                googleMapsConfig?.saveApiKeyForReload?.(apiKey);
                close();
                reloadPage();
                return;
            }
            googleMapsConfig?.updateConfig?.({ apiKey });
            close(apiKey);
        } catch (error) {
            elements.googleMapsServiceStatus.textContent = error?.message ?? "Google Maps API Key 保存失败。";
        }
    }

    const onConfirm = () => confirm();
    const onCancel = () => close();
    const onOverlayClick = (event) => {
        if (event.target === elements.googleMapsServiceOverlay) close();
    };
    const onKeyDown = (event) => {
        if (event.key === "Escape") close();
        if (event.key === "Enter") confirm();
    };

    elements.confirmGoogleMapsServiceBtn?.addEventListener("click", onConfirm);
    elements.cancelGoogleMapsServiceBtn?.addEventListener("click", onCancel);
    elements.googleMapsServiceOverlay?.addEventListener("click", onOverlayClick);
    elements.googleMapsServiceApiKeyInput?.addEventListener("keydown", onKeyDown);

    return {
        requestApiKey,
        destroy() {
            close();
            elements.confirmGoogleMapsServiceBtn?.removeEventListener("click", onConfirm);
            elements.cancelGoogleMapsServiceBtn?.removeEventListener("click", onCancel);
            elements.googleMapsServiceOverlay?.removeEventListener("click", onOverlayClick);
            elements.googleMapsServiceApiKeyInput?.removeEventListener("keydown", onKeyDown);
        }
    };
}

function reloadBrowserPage() {
    globalThis.location?.reload?.();
}
