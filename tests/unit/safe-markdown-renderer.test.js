import { createAgentPresentationRenderer } from "../../src/ui/agent/agent-presentation-renderer.js";
import { renderSafeMarkdown } from "../../src/ui/shared/safe-markdown-renderer.js";
import { assert, assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "safe-markdown-renderer",
    tests: [
        {
            name: "renders the supported report structure as DOM nodes",
            run() {
                const root = createRoot();
                const nodes = renderSafeMarkdown(root, [
                    "## 训练结论",
                    "本月 **训练量增加**，执行 `Z2`。",
                    "",
                    "- 保持恢复",
                    "- 观察心率",
                    "",
                    "| 周 | 距离 |",
                    "|---|---|",
                    "| W31 | **79.4km** |",
                    "",
                    "```text",
                    "FTP=260",
                    "```"
                ].join("\n"));

                assertEqual(nodes.map((node) => node.tagName).join(","), "H2,P,UL,DIV,PRE");
                assertEqual(nodes[1].children[1].tagName, "STRONG");
                assertEqual(nodes[1].children[3].tagName, "CODE");
                assertEqual(nodes[2].children.length, 2);
                const table = nodes[3].children[0];
                assertEqual(table.tagName, "TABLE");
                assertEqual(table.children[1].children[0].children[1].children[0].tagName, "STRONG");
                assertEqual(nodes[4].children[0].textContent, "FTP=260");
            }
        },
        {
            name: "renders table cell HTML as inert text",
            run() {
                const root = createRoot();
                const nodes = renderSafeMarkdown(root, [
                    "| 指标 | 内容 |",
                    "|---|---|",
                    "| 风险 | <img src=x onerror=alert(1)> |"
                ].join("\n"));
                const tags = flatten(nodes).map((node) => node.tagName);

                assertEqual(nodes[0].children[0].tagName, "TABLE");
                assert(!tags.includes("IMG"), "table HTML must remain inert text");
                assert(collectText(nodes[0]).includes("<img src=x onerror=alert(1)>"));
            }
        },
        {
            name: "keeps raw HTML inert instead of creating supplied elements",
            run() {
                const root = createRoot();
                const nodes = renderSafeMarkdown(root, "<img src=x onerror=alert(1)> **安全文本**");
                const tags = flatten(nodes).map((node) => node.tagName);

                assertEqual(nodes[0].tagName, "P");
                assert(!tags.includes("IMG"), "raw HTML must not create an image element");
                assert(collectText(nodes[0]).includes("<img src=x onerror=alert(1)>"));
            }
        },
        {
            name: "presentation markdown blocks use the safe renderer",
            run() {
                const root = createRoot();
                const container = root.createElement("div");
                const title = root.createElement("strong");
                const renderer = createAgentPresentationRenderer({ root, container, titleElement: title });

                renderer.render([{
                    type: "markdown",
                    title: "训练趋势总结",
                    data: { markdown: "## 结论\n- **保持训练**" }
                }]);

                const markdownContainer = container.children[0].children[1];
                assertEqual(markdownContainer.children[0].tagName, "H2");
                assertEqual(markdownContainer.children[1].tagName, "UL");
                assertEqual(title.textContent, "训练趋势总结");
            }
        },
        {
            name: "presentation charts create real SVG namespace elements",
            run() {
                const root = createRoot();
                const svgTags = [];
                root.createElementNS = (namespace, tagName) => {
                    assertEqual(namespace, "http://www.w3.org/2000/svg");
                    svgTags.push(tagName);
                    return createNode(String(tagName).toUpperCase());
                };
                const container = root.createElement("div");
                const renderer = createAgentPresentationRenderer({ root, container });

                renderer.render([{
                    type: "line_chart",
                    title: "训练周期趋势",
                    data: {
                        labels: ["W31", "W35"],
                        series: [{ metric: "distance_km", unit: "km", values: [79.4, 18.3] }]
                    }
                }]);

                assertEqual(svgTags.join(","), "svg,polyline");
            }
        },
        {
            name: "presentation tables localize training-history values",
            run() {
                const root = createRoot();
                const container = root.createElement("div");
                const renderer = createAgentPresentationRenderer({ root, container });

                renderer.render([{
                    type: "table",
                    title: "训练趋势对比",
                    data: {
                        columns: ["dimension", "metric", "unit", "confidence"],
                        rows: [{
                            dimension: "volume",
                            metric: "distance_km",
                            unit: "km",
                            confidence: "medium"
                        }]
                    }
                }]);

                const table = container.children[0].children[1].children[0];
                const cells = table.children[1].children[0].children;
                assertEqual(cells.map((cell) => cell.textContent).join(","), "训练量,距离,km,中");
            }
        }
    ]
};

function createRoot() {
    return {
        createElement(tagName) {
            return createNode(String(tagName).toUpperCase());
        },
        createTextNode(text) {
            return { tagName: "#TEXT", textContent: String(text), children: [] };
        }
    };
}

function createNode(tagName) {
    return {
        tagName,
        className: "",
        textContent: "",
        dataset: {},
        attributes: {},
        children: [],
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = [...children]; },
        setAttribute(name, value) { this.attributes[name] = String(value); }
    };
}

function flatten(nodes) {
    return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

function collectText(node) {
    return `${node.textContent || ""}${(node.children ?? []).map(collectText).join("")}`;
}
