import { replaceWithSafeMarkdown } from "../shared/safe-markdown-renderer.js";

const METRIC_LABELS = {
    activity_count: "活动数量",
    sport_type: "运动类型",
    start_time_local: "开始时间",
    duration_min: "时长",
    distance_km: "距离",
    summary_label: "活动结论",
    tss: "TSS",
    intensity_factor: "IF",
    main_stimulus: "主要刺激",
    load_label: "负荷"
};

const COLUMN_LABELS = {
    dimension: "维度",
    metric: "指标",
    baseline: "基线",
    current: "当前",
    change: "变化",
    unit: "单位",
    confidence: "可信度",
    start_time_local: "开始时间",
    summary_label: "结论",
    sport_type: "类型",
    duration_min: "时长 min",
    distance_km: "距离 km",
    tss: "TSS",
    intensity_factor: "IF",
    main_stimulus: "主要刺激",
    load_label: "负荷"
};

const DIMENSION_LABELS = {
    volume: "训练量",
    intensity: "强度",
    consistency: "规律性",
    performance: "表现",
    efficiency: "效率",
    recovery: "恢复"
};

const CONFIDENCE_LABELS = { low: "低", medium: "中", high: "高" };
const UNIT_LABELS = { min: "分钟", count: "次", day: "天" };

export function createAgentPresentationRenderer({ root = document, container, titleElement }) {
    function render(presentations, { fallbackText = "" } = {}) {
        const blocks = (Array.isArray(presentations) ? presentations : [])
            .map(renderBlock)
            .filter(Boolean);
        if (!blocks.length && fallbackText) {
            blocks.push(renderMarkdown({ title: "Agent 回答", data: { markdown: fallbackText } }));
        }
        if (!blocks.length) {
            blocks.push(createNote("本轮没有可展示的结构化结果。"));
        }
        container?.replaceChildren(...blocks);
        if (titleElement) {
            titleElement.textContent = presentations?.[0]?.title || "Agent 分析结果";
        }
    }

    function clear() {
        container?.replaceChildren(createNote("发送问题后，活动指标、趋势和报告会显示在这里。"));
        if (titleElement) titleElement.textContent = "Agent 分析结果";
    }

    function renderBlock(block) {
        if (!block || typeof block !== "object") return null;
        if (block.type === "metric_cards") return renderMetricCards(block);
        if (block.type === "line_chart") return renderLineChart(block);
        if (block.type === "table") return renderTable(block);
        if (block.type === "markdown") return renderMarkdown(block);
        return null;
    }

    function renderMetricCards(block) {
        const section = createSection(block.title);
        const grid = root.createElement("div");
        grid.className = "agent-metric-grid";
        for (const item of block.data?.items ?? []) {
            if (!item || item.value === null || item.value === undefined || item.value === "") continue;
            const metric = root.createElement("div");
            const label = root.createElement("span");
            const value = root.createElement("strong");
            label.textContent = METRIC_LABELS[item.metric] || humanizeKey(item.metric);
            value.textContent = formatValue(item.value, item.unit);
            metric.append(label, value);
            grid.append(metric);
        }
        section.append(grid);
        return section;
    }

    function renderTable(block) {
        const columns = Array.isArray(block.data?.columns) ? block.data.columns : [];
        const rows = Array.isArray(block.data?.rows) ? block.data.rows : [];
        if (!columns.length || !rows.length) return null;
        const section = createSection(block.title);
        const shell = root.createElement("div");
        shell.className = "agent-result-table-shell";
        const table = root.createElement("table");
        const thead = root.createElement("thead");
        const headerRow = root.createElement("tr");
        columns.forEach((column) => {
            const cell = root.createElement("th");
            cell.textContent = COLUMN_LABELS[column] || humanizeKey(column);
            headerRow.append(cell);
        });
        thead.append(headerRow);
        const tbody = root.createElement("tbody");
        rows.forEach((row) => {
            const tableRow = root.createElement("tr");
            columns.forEach((column) => {
                const cell = root.createElement("td");
                cell.textContent = formatCell(row?.[column], column);
                tableRow.append(cell);
            });
            tbody.append(tableRow);
        });
        table.append(thead, tbody);
        shell.append(table);
        section.append(shell);
        return section;
    }

    function renderLineChart(block) {
        const series = (block.data?.series ?? []).filter((item) => Array.isArray(item?.values));
        if (!series.length) return null;
        const section = createSection(block.title);
        const chart = root.createElement("div");
        chart.className = "agent-series-chart";
        series.forEach((item) => chart.append(renderSeries(item, block.data?.labels)));
        section.append(chart);
        return section;
    }

    function renderSeries(series, labels) {
        const row = root.createElement("div");
        row.className = "agent-series-row";
        const heading = root.createElement("div");
        const name = root.createElement("strong");
        const range = root.createElement("span");
        const values = series.values.map(toFiniteNumber);
        const numeric = values.filter((value) => value !== null);
        name.textContent = METRIC_LABELS[series.metric] || humanizeKey(series.metric);
        range.textContent = numeric.length
            ? `${formatValue(numeric[0], series.unit)} → ${formatValue(numeric.at(-1), series.unit)}`
            : "暂无数据";
        heading.append(name, range);
        const svg = createSvgElement(root, "svg");
        svg.setAttribute("viewBox", "0 0 560 120");
        svg.setAttribute("preserveAspectRatio", "none");
        const polyline = createSvgElement(root, "polyline");
        polyline.setAttribute("points", buildPolyline(values, 560, 120));
        polyline.setAttribute("fill", "none");
        polyline.setAttribute("stroke", "currentColor");
        polyline.setAttribute("stroke-width", "3");
        polyline.setAttribute("vector-effect", "non-scaling-stroke");
        svg.append(polyline);
        const axis = root.createElement("div");
        axis.className = "agent-series-axis";
        const first = root.createElement("span");
        const last = root.createElement("span");
        first.textContent = labels?.[0] ?? "开始";
        last.textContent = labels?.at?.(-1) ?? "结束";
        axis.append(first, last);
        row.append(heading, svg, axis);
        return row;
    }

    function renderMarkdown(block) {
        const section = createSection(block.title);
        const content = root.createElement("div");
        content.className = "agent-markdown-result";
        replaceWithSafeMarkdown(root, content, block.data?.markdown || "");
        section.append(content);
        return section;
    }

    function createSection(title) {
        const section = root.createElement("section");
        section.className = "agent-result-block";
        if (title) {
            const heading = root.createElement("h3");
            heading.textContent = title;
            section.append(heading);
        }
        return section;
    }

    function createNote(text) {
        const note = root.createElement("p");
        note.className = "agent-workspace-hint";
        note.textContent = text;
        return note;
    }

    return { clear, render };
}

function createSvgElement(root, tagName) {
    return typeof root.createElementNS === "function"
        ? root.createElementNS("http://www.w3.org/2000/svg", tagName)
        : root.createElement(tagName);
}

function buildPolyline(values, width, height) {
    const numeric = values.filter((value) => value !== null);
    if (!numeric.length) return "";
    const min = Math.min(...numeric);
    const max = Math.max(...numeric);
    const range = max - min || 1;
    const lastIndex = Math.max(1, values.length - 1);
    return values.map((value, index) => {
        if (value === null) return null;
        const x = (index / lastIndex) * width;
        const y = height - 8 - ((value - min) / range) * (height - 16);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).filter(Boolean).join(" ");
}

function toFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function formatCell(value, column) {
    if (value === null || value === undefined || value === "") return "--";
    if (typeof value === "boolean") return value ? "是" : "否";
    if (column === "change" && Number.isFinite(Number(value))) return `${Number(value).toFixed(1)}%`;
    if (column === "dimension") return DIMENSION_LABELS[value] || String(value);
    if (column === "metric") return METRIC_LABELS[value] || humanizeKey(value);
    if (column === "confidence") return CONFIDENCE_LABELS[value] || String(value);
    if (column === "unit") return UNIT_LABELS[value] || String(value);
    return String(value);
}

function formatValue(value, unit) {
    return `${value}${unit ? ` ${UNIT_LABELS[unit] || unit}` : ""}`;
}

function humanizeKey(value) {
    return String(value || "指标").replaceAll("_", " ");
}
