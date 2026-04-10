export function createPipController({ button, template, getData, getConfig }) {
    let pipWindow = null;

    function render() {
        if (!pipWindow) {
            return;
        }

        const container = pipWindow.document.getElementById("pip-dynamic-row");

        if (!container) {
            return;
        }

        const config = getConfig();
        const parts = [];

        if (config.hr) {
            parts.push(`
                <div class="pip-data">
                    <span class="pip-icon">❤️</span>
                    <span id="pipHeartRate">--</span>
                    <span class="pip-unit">bpm</span>
                </div>
            `);
        }

        if (config.power) {
            parts.push(`
                <div class="pip-data">
                    <span class="pip-icon">⚡</span>
                    <span id="pipPower">--</span>
                    <span class="pip-unit">W</span>
                </div>
            `);
        }

        if (config.time) {
            parts.push(`
                <div class="pip-data time-color">
                    <span class="pip-icon">⏱️</span>
                    <span id="pipTime">00:00</span>
                </div>
            `);
        }

        if (config.np) {
            parts.push(`
                <div class="pip-data np-color">
                    <span class="pip-icon">AVG</span>
                    <span id="pipNp">--</span>
                    <span class="pip-unit">W</span>
                </div>
            `);
        }

        container.innerHTML = parts.join("");
        sync();
    }

    function sync() {
        if (!pipWindow) {
            return;
        }

        const data = getData();

        const hrEl = pipWindow.document.getElementById("pipHeartRate");
        const powerEl = pipWindow.document.getElementById("pipPower");
        const timeEl = pipWindow.document.getElementById("pipTime");
        const npEl = pipWindow.document.getElementById("pipNp");

        if (hrEl) {
            hrEl.innerText = data.hr;
        }

        if (powerEl) {
            powerEl.innerText = data.power;
        }

        if (timeEl) {
            timeEl.innerText = data.time;
        }

        if (npEl) {
            npEl.innerText = data.np;
        }
    }

    function refreshButtonState() {
        if (!button) {
            return;
        }

        button.innerText = pipWindow ? "关闭悬浮窗" : "开启悬浮窗";
        button.style.backgroundColor = pipWindow ? "var(--danger)" : "var(--secondary)";
    }

    async function open() {
        pipWindow = await window.documentPictureInPicture.requestWindow({
            width: 320,
            height: 140,
            disallowReturnToOpener: true
        });

        const pipContent = template.content.cloneNode(true);
        pipWindow.document.body.append(pipContent);

        [...document.styleSheets].forEach((styleSheet) => {
            try {
                const cssRules = [...styleSheet.cssRules].map((rule) => rule.cssText).join("");
                const style = document.createElement("style");
                style.textContent = cssRules;
                pipWindow.document.head.appendChild(style);
            } catch (error) {
                if (!styleSheet.href) {
                    return;
                }

                const link = document.createElement("link");
                link.rel = "stylesheet";
                link.type = styleSheet.type;
                link.media = styleSheet.media;
                link.href = styleSheet.href;
                pipWindow.document.head.appendChild(link);
            }
        });

        render();
        refreshButtonState();

        pipWindow.addEventListener("pagehide", () => {
            pipWindow = null;
            refreshButtonState();
        });
    }

    async function toggle() {
        if (!("documentPictureInPicture" in window)) {
            return;
        }

        if (pipWindow) {
            pipWindow.close();
            return;
        }

        try {
            await open();
        } catch (error) {
            console.error("开启悬浮窗失败", error);
            alert("开启悬浮窗失败，请确保使用最新版 Chrome 或 Edge 浏览器。");
        }
    }

    if (button) {
        button.addEventListener("click", toggle);
    }

    refreshButtonState();

    return {
        render,
        sync,
        isSupported: "documentPictureInPicture" in window
    };
}
