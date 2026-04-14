export function createPipController({ button, template, getData }) {
    let pipWindow = null;

    function render() {
        if (!pipWindow) {
            return;
        }

        const container = pipWindow.document.getElementById("pip-metrics-grid");

        if (!container) {
            return;
        }

        container.innerHTML = `
            <style>
                body {
                    margin: 0;
                    padding: 10px;
                    background-color: var(--surface);
                    color: var(--text);
                    font-family: system-ui, -apple-system, sans-serif;
                }
                .pip-metrics-grid {
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                }
                .pip-section {
                    background: var(--background);
                    border-radius: 8px;
                    padding: 8px;
                    border: 1px solid var(--border);
                }
                .pip-section-title {
                    font-size: 11px;
                    color: var(--muted);
                    margin-bottom: 6px;
                }
                .pip-training-grid {
                    display: grid;
                    grid-template-columns: repeat(3, minmax(0, 1fr));
                    gap: 6px;
                }
                .pip-metric {
                    background: rgba(255, 255, 255, 0.02);
                    border-radius: 6px;
                    padding: 6px 4px;
                    text-align: center;
                }
                .pip-metric-label {
                    font-size: 10px;
                    color: var(--muted);
                    margin-bottom: 3px;
                }
                .pip-metric-val {
                    font-size: 15px;
                    font-weight: bold;
                }
                .pip-metric-unit {
                    font-size: 10px;
                    color: var(--muted);
                    font-weight: normal;
                }
                .pip-grade-grid {
                    display: grid;
                    grid-template-columns: repeat(3, minmax(0, 1fr));
                    gap: 6px;
                    margin-bottom: 8px;
                }
                .pip-grade-card {
                    border-radius: 6px;
                    padding: 6px 4px;
                    text-align: center;
                    background: rgba(255, 255, 255, 0.02);
                }
                .pip-grade-value {
                    font-size: 16px;
                    font-weight: 700;
                }
                .pip-status {
                    margin-top: 8px;
                    font-size: 10px;
                    color: var(--muted);
                    line-height: 1.4;
                    min-height: 28px;
                }
                .pip-grade-svg {
                    width: 100%;
                    height: 72px;
                    display: block;
                    background: rgba(15, 23, 42, 0.24);
                    border-radius: 6px;
                }
                .power-color { color: var(--primary); }
                .hr-color { color: var(--danger); }
                .accent-color { color: var(--accent); }
                .climb-color { color: #f97316; }
            </style>
            <section class="pip-section">
                <div class="pip-section-title">训练数据</div>
                <div class="pip-training-grid">
                    <div class="pip-metric">
                        <div class="pip-metric-label">模式</div>
                        <div class="pip-metric-val"><span id="pipMode">--</span></div>
                    </div>
                    <div class="pip-metric">
                        <div class="pip-metric-label">实时速度</div>
                        <div class="pip-metric-val accent-color"><span id="pipSpeed">--</span> <span class="pip-metric-unit">km/h</span></div>
                    </div>
                    <div class="pip-metric">
                        <div class="pip-metric-label">骑行距离</div>
                        <div class="pip-metric-val"><span id="pipDist">--</span> <span class="pip-metric-unit">km</span></div>
                    </div>
                    <div class="pip-metric">
                        <div class="pip-metric-label">实时功率</div>
                        <div class="pip-metric-val power-color"><span id="pipPower">--</span> <span class="pip-metric-unit">W</span></div>
                    </div>
                    <div class="pip-metric">
                        <div class="pip-metric-label">心率</div>
                        <div class="pip-metric-val hr-color"><span id="pipHr">--</span> <span class="pip-metric-unit">bpm</span></div>
                    </div>
                    <div class="pip-metric">
                        <div class="pip-metric-label">踏频</div>
                        <div class="pip-metric-val accent-color"><span id="pipCadence">--</span> <span class="pip-metric-unit">rpm</span></div>
                    </div>
                    <div class="pip-metric" style="grid-column: span 3;">
                        <div class="pip-metric-label">剩余距离</div>
                        <div class="pip-metric-val"><span id="pipRem">--</span> <span class="pip-metric-unit">km</span></div>
                    </div>
                </div>
            </section>
            <section class="pip-section">
                <div class="pip-section-title">实时坡度</div>
                <div class="pip-grade-grid">
                    <div class="pip-grade-card">
                        <div class="pip-metric-label">当前坡度</div>
                        <div class="pip-grade-value climb-color"><span id="pipCurrentGrade">--</span><span class="pip-metric-unit">%</span></div>
                    </div>
                    <div class="pip-grade-card">
                        <div class="pip-metric-label">前方坡度</div>
                        <div class="pip-grade-value accent-color"><span id="pipLookaheadGrade">--</span><span class="pip-metric-unit">%</span></div>
                    </div>
                    <div class="pip-grade-card">
                        <div class="pip-metric-label">目标模拟坡度</div>
                        <div class="pip-grade-value power-color"><span id="pipTargetGrade">--</span><span class="pip-metric-unit">%</span></div>
                    </div>
                </div>
                <svg id="pipElevationChart" class="pip-grade-svg" viewBox="0 0 320 72" preserveAspectRatio="none"></svg>
                <div id="pipControlStatus" class="pip-status">--</div>
            </section>
        `;

        sync();
    }

    function renderElevationChart(route, currentRecord) {
        if (!pipWindow) return;
        const chartEl = pipWindow.document.getElementById("pipElevationChart");
        if (!chartEl) return;

        if (!route || !route.points || route.points.length === 0) {
            chartEl.innerHTML = `
                <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="12">
                    暂无路线数据
                </text>
            `;
            return;
        }

        const width = 320;
        const height = 72;
        const paddingBottom = 10;
        const paddingTop = 10;
        const innerHeight = height - paddingTop - paddingBottom;

        const totalDist = route.totalDistanceMeters;
        const maxGrade = Math.max(...route.points.map((point) => point.gradePercent), 5);
        const minGrade = Math.min(...route.points.map((point) => point.gradePercent), -5);
        const gradeRange = maxGrade - minGrade;
        const zeroY = paddingTop + innerHeight * (maxGrade / gradeRange);

        let svgContent = "";

        function getGradeColor(grade) {
            if (grade >= 10) return "#e11d48";
            if (grade >= 7) return "#f43f5e";
            if (grade >= 4) return "#f97316";
            if (grade >= 2) return "#fbbf24";
            if (grade > -2) return "#2dd4bf";
            return "#38bdf8";
        }

        svgContent += `<line x1="0" y1="${zeroY}" x2="${width}" y2="${zeroY}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="2 2" />`;

        for (let i = 1; i < route.points.length; i += 1) {
            const prevPoint = route.points[i - 1];
            const currentPoint = route.points[i];

            const prevX = (prevPoint.distanceMeters / totalDist) * width;
            const curX = (currentPoint.distanceMeters / totalDist) * width;
            const prevY = paddingTop + innerHeight * ((maxGrade - prevPoint.gradePercent) / gradeRange);
            const curY = paddingTop + innerHeight * ((maxGrade - currentPoint.gradePercent) / gradeRange);
            const color = getGradeColor(currentPoint.gradePercent);

            svgContent += `
                <polygon points="${prevX},${zeroY} ${prevX},${prevY} ${curX},${curY} ${curX},${zeroY}" fill="${color}" opacity="0.8" />
                <line x1="${prevX}" y1="${prevY}" x2="${curX}" y2="${curY}" stroke="${color}" stroke-width="1" />
            `;
        }

        if (currentRecord) {
            const posX = (currentRecord.distanceKm * 1000 / totalDist) * width;
            svgContent += `
                <rect x="0" y="0" width="${posX}" height="${height}" fill="rgba(0, 0, 0, 0.2)" />
                <line x1="${posX}" y1="0" x2="${posX}" y2="${height}" stroke="var(--text)" stroke-width="1.5" stroke-dasharray="2 2" />
                <circle cx="${posX}" cy="${zeroY}" r="3" fill="white" stroke="var(--text)" stroke-width="1.5" />
            `;
        }

        chartEl.innerHTML = svgContent;
    }

    function sync() {
        if (!pipWindow) {
            return;
        }

        const data = getData();
        const distEl = pipWindow.document.getElementById("pipDist");
        const remEl = pipWindow.document.getElementById("pipRem");
        const speedEl = pipWindow.document.getElementById("pipSpeed");
        const powerEl = pipWindow.document.getElementById("pipPower");
        const hrEl = pipWindow.document.getElementById("pipHr");
        const cadenceEl = pipWindow.document.getElementById("pipCadence");
        const modeEl = pipWindow.document.getElementById("pipMode");
        const currentGradeEl = pipWindow.document.getElementById("pipCurrentGrade");
        const lookaheadGradeEl = pipWindow.document.getElementById("pipLookaheadGrade");
        const targetGradeEl = pipWindow.document.getElementById("pipTargetGrade");
        const controlStatusEl = pipWindow.document.getElementById("pipControlStatus");

        if (distEl) distEl.innerText = data.distance;
        if (remEl) remEl.innerText = data.remaining;
        if (speedEl) speedEl.innerText = data.speed;
        if (powerEl) powerEl.innerText = data.power;
        if (hrEl) hrEl.innerText = data.hr;
        if (cadenceEl) cadenceEl.innerText = data.cadence;
        if (modeEl) modeEl.innerText = data.modeLabel;
        if (currentGradeEl) currentGradeEl.innerText = data.currentGrade;
        if (lookaheadGradeEl) lookaheadGradeEl.innerText = data.lookaheadGrade;
        if (targetGradeEl) targetGradeEl.innerText = data.targetTrainerGrade;
        if (controlStatusEl) controlStatusEl.innerText = data.controlStatus;

        renderElevationChart(data.route, data.currentRecord);
    }

    function refreshButtonState() {
        if (!button) {
            return;
        }

        button.innerText = pipWindow ? "关闭悬浮窗" : "开启悬浮窗";

        if (pipWindow) {
            button.classList.add("danger");
            button.classList.remove("secondary");
            button.style.backgroundColor = "var(--danger)";
        } else {
            button.classList.add("secondary");
            button.classList.remove("danger");
            button.style.backgroundColor = "var(--secondary)";
        }
    }

    async function open() {
        pipWindow = await window.documentPictureInPicture.requestWindow({
            width: 320,
            height: 240,
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
