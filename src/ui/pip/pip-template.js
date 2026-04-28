export function buildPipContentHtml() {
    return `
        ${buildPipStyleHtml()}
        <section class="pip-section">
            <div class="pip-section-title">训练数据</div>
            <div id="pipMetricsList" class="pip-training-grid"></div>
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
                    <div id="pipTargetLabel" class="pip-metric-label">目标控制值</div>
                    <div class="pip-grade-value power-color"><span id="pipTargetGrade">--</span><span id="pipTargetUnit" class="pip-metric-unit">%</span></div>
                </div>
            </div>
            <svg id="pipElevationChart" class="pip-grade-svg" viewBox="0 0 320 72" preserveAspectRatio="none"></svg>
            <div id="pipControlStatus" class="pip-status">--</div>
        </section>
    `;
}

function buildPipStyleHtml() {
    return `
        <style>
            body {
                margin: 0;
                padding: 12px;
                background: #020617;
                color: #f8fafc;
                font-family: system-ui, -apple-system, sans-serif;
            }
            .pip-metrics-grid {
                display: flex;
                flex-direction: column;
                gap: 12px;
            }
            .pip-section {
                background: #111827;
                border-radius: 8px;
                padding: 10px;
                border: 1px solid rgba(148, 163, 184, 0.24);
                box-shadow: 0 16px 34px rgba(0, 0, 0, 0.28);
            }
            .pip-section-title {
                font-size: 11px;
                color: #94a3b8;
                margin-bottom: 8px;
                font-weight: 800;
                text-transform: uppercase;
            }
            .pip-training-grid {
                display: grid;
                grid-template-columns: repeat(3, minmax(0, 1fr));
                gap: 8px;
            }
            .pip-training-grid.compact {
                grid-template-columns: repeat(2, minmax(0, 1fr));
            }
            .pip-training-grid.wide {
                grid-template-columns: 1fr;
            }
            .pip-metric {
                background: #1f2937;
                border: 1px solid rgba(148, 163, 184, 0.18);
                border-radius: 6px;
                padding: 8px 6px;
                text-align: center;
            }
            .pip-metric-label {
                font-size: 10px;
                color: #94a3b8;
                margin-bottom: 3px;
            }
            .pip-metric-val {
                color: #f8fafc;
                font-size: 16px;
                font-weight: bold;
            }
            .pip-metric-unit {
                font-size: 10px;
                color: #94a3b8;
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
                padding: 8px 6px;
                text-align: center;
                background: #1f2937;
                border: 1px solid rgba(148, 163, 184, 0.18);
            }
            .pip-grade-value {
                font-size: 16px;
                font-weight: 700;
            }
            .pip-status {
                margin-top: 8px;
                font-size: 10px;
                color: #cbd5e1;
                line-height: 1.4;
                min-height: 28px;
            }
            .pip-grade-svg {
                width: 100%;
                height: 72px;
                display: block;
                background: #020617;
                border-radius: 6px;
            }
            .power-color { color: #22c55e; }
            .hr-color { color: #fb7185; }
            .accent-color { color: #38bdf8; }
            .climb-color { color: #f97316; }
        </style>
    `;
}
