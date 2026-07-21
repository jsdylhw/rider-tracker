export function createGoogleMapsServiceModal({ elements, googleMapsConfig }) {
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
        elements.googleMapsServiceDescription.textContent = "输入 Key 后才会发起请求。连接失败时，可直接更改 Key 后再次请求。";
        elements.googleMapsServiceStatus.textContent = "";
        elements.googleMapsServiceApiKeyInput.value = config?.apiKey ?? "";
        if (elements.confirmGoogleMapsServiceBtn) {
            elements.confirmGoogleMapsServiceBtn.textContent = featureLabel === "加载街景" ? "连接街景" : "使用此 Key 请求";
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
                elements.googleMapsServiceStatus.textContent = "当前页面已使用既有 Key 初始化 Google Maps，不能热更换。可关闭窗口继续使用当前街景。";
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
    const onClose = () => close();
    const onKeyDown = (event) => {
        if (event.key === "Escape") close();
        if (event.key === "Enter") confirm();
    };

    elements.confirmGoogleMapsServiceBtn?.addEventListener("click", onConfirm);
    elements.cancelGoogleMapsServiceBtn?.addEventListener("click", onCancel);
    elements.closeGoogleMapsServiceBtn?.addEventListener("click", onClose);
    elements.googleMapsServiceApiKeyInput?.addEventListener("keydown", onKeyDown);

    return {
        requestApiKey,
        destroy() {
            close();
            elements.confirmGoogleMapsServiceBtn?.removeEventListener("click", onConfirm);
            elements.cancelGoogleMapsServiceBtn?.removeEventListener("click", onCancel);
            elements.closeGoogleMapsServiceBtn?.removeEventListener("click", onClose);
            elements.googleMapsServiceApiKeyInput?.removeEventListener("keydown", onKeyDown);
        }
    };
}
