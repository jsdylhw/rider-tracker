/**
 * Render the small Markdown subset used by Agent reports without parsing HTML.
 *
 * All user/model supplied content reaches the DOM through textContent (or a
 * Text node). Raw HTML, links and images are deliberately unsupported.
 */
export function renderSafeMarkdown(root, markdown) {
    const lines = String(markdown ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
    const nodes = [];
    let paragraphLines = [];
    let list = null;

    const flushParagraph = () => {
        if (!paragraphLines.length) return;
        const paragraph = root.createElement("p");
        appendInlineMarkdown(root, paragraph, paragraphLines.join(" ").trim());
        nodes.push(paragraph);
        paragraphLines = [];
    };

    const flushList = () => {
        if (!list) return;
        nodes.push(list.element);
        list = null;
    };

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const fence = line.match(/^\s*```([\w-]*)\s*$/);
        if (fence) {
            flushParagraph();
            flushList();
            const codeLines = [];
            index += 1;
            while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
                codeLines.push(lines[index]);
                index += 1;
            }
            const pre = root.createElement("pre");
            const code = root.createElement("code");
            if (fence[1]) code.dataset.language = fence[1];
            code.textContent = codeLines.join("\n");
            pre.append(code);
            nodes.push(pre);
            continue;
        }

        if (!line.trim()) {
            flushParagraph();
            flushList();
            continue;
        }

        if (isTableHeader(lines, index)) {
            flushParagraph();
            flushList();
            const headerCells = splitTableRow(line);
            const shell = root.createElement("div");
            shell.className = "agent-markdown-table-shell";
            const table = root.createElement("table");
            const thead = root.createElement("thead");
            const headerRow = root.createElement("tr");
            headerCells.forEach((value) => {
                const cell = root.createElement("th");
                appendInlineMarkdown(root, cell, value);
                headerRow.append(cell);
            });
            thead.append(headerRow);
            const tbody = root.createElement("tbody");
            index += 2;
            while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
                const row = root.createElement("tr");
                const values = splitTableRow(lines[index]);
                headerCells.forEach((_, cellIndex) => {
                    const cell = root.createElement("td");
                    appendInlineMarkdown(root, cell, values[cellIndex] ?? "");
                    row.append(cell);
                });
                tbody.append(row);
                index += 1;
            }
            index -= 1;
            table.append(thead, tbody);
            shell.append(table);
            nodes.push(shell);
            continue;
        }

        const heading = line.match(/^(#{1,3})\s+(.+)$/);
        if (heading) {
            flushParagraph();
            flushList();
            const element = root.createElement(`h${heading[1].length}`);
            appendInlineMarkdown(root, element, heading[2].trim());
            nodes.push(element);
            continue;
        }

        const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
        const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
        if (unordered || ordered) {
            flushParagraph();
            const kind = ordered ? "ol" : "ul";
            if (!list || list.kind !== kind) {
                flushList();
                list = { kind, element: root.createElement(kind) };
            }
            const item = root.createElement("li");
            appendInlineMarkdown(root, item, (ordered || unordered)[1].trim());
            list.element.append(item);
            continue;
        }

        flushList();
        paragraphLines.push(line.trim());
    }

    flushParagraph();
    flushList();
    return nodes;
}

function isTableHeader(lines, index) {
    if (!lines[index]?.includes("|") || index + 1 >= lines.length) return false;
    const separators = splitTableRow(lines[index + 1]);
    const headers = splitTableRow(lines[index]);
    return headers.length > 1
        && separators.length === headers.length
        && separators.every((value) => /^:?-{3,}:?$/.test(value));
}

function splitTableRow(line) {
    let normalized = String(line ?? "").trim();
    if (normalized.startsWith("|")) normalized = normalized.slice(1);
    if (normalized.endsWith("|")) normalized = normalized.slice(0, -1);
    return normalized.split("|").map((value) => value.trim());
}

export function replaceWithSafeMarkdown(root, container, markdown) {
    const nodes = renderSafeMarkdown(root, markdown);
    container.replaceChildren(...nodes);
    return nodes;
}

function appendInlineMarkdown(root, parent, text) {
    let remaining = String(text ?? "");
    while (remaining) {
        const strongStart = remaining.indexOf("**");
        const codeStart = remaining.indexOf("`");
        const candidates = [strongStart, codeStart].filter((index) => index >= 0);
        if (!candidates.length) {
            appendText(root, parent, remaining);
            return;
        }

        const start = Math.min(...candidates);
        if (start > 0) appendText(root, parent, remaining.slice(0, start));
        const isStrong = remaining.startsWith("**", start);
        const marker = isStrong ? "**" : "`";
        const contentStart = start + marker.length;
        const end = remaining.indexOf(marker, contentStart);
        if (end < 0) {
            appendText(root, parent, remaining.slice(start));
            return;
        }

        const element = root.createElement(isStrong ? "strong" : "code");
        element.textContent = remaining.slice(contentStart, end);
        parent.append(element);
        remaining = remaining.slice(end + marker.length);
    }
}

function appendText(root, parent, text) {
    if (!text) return;
    if (typeof root.createTextNode === "function") {
        parent.append(root.createTextNode(text));
        return;
    }
    const fallback = root.createElement("span");
    fallback.textContent = text;
    parent.append(fallback);
}
