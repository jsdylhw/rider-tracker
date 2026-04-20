function decodeEntities(text) {
    return String(text ?? "")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&");
}

function parseAttributes(raw = "") {
    const attrs = {};
    raw.replace(/([\w:-]+)\s*=\s*"([^"]*)"/g, (_, key, value) => {
        attrs[key] = decodeEntities(value);
        return "";
    });
    return attrs;
}

class MockTextNode {
    constructor(textContent) {
        this.textContent = decodeEntities(textContent ?? "");
    }
}

class MockTrackPointNode {
    constructor(attrs, body) {
        this.attrs = attrs;
        this.body = body;
    }

    getAttribute(name) {
        return this.attrs[name] ?? null;
    }

    querySelector(selector) {
        if (selector !== "ele") {
            return null;
        }
        const match = this.body.match(/<ele[^>]*>([\s\S]*?)<\/ele>/i);
        return match ? new MockTextNode(match[1]) : null;
    }
}

class MockXmlDocument {
    constructor(xmlText) {
        this.xmlText = xmlText;
    }

    querySelector(selector) {
        if (selector === "parsererror") {
            return null;
        }
        if (selector === "metadata > name, trk > name, rte > name") {
            const candidates = [
                /<metadata[\s\S]*?<name[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/metadata>/i,
                /<trk[\s\S]*?<name[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/trk>/i,
                /<rte[\s\S]*?<name[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/rte>/i
            ];
            for (const regex of candidates) {
                const match = this.xmlText.match(regex);
                if (match) {
                    return new MockTextNode(match[1].trim());
                }
            }
            return null;
        }
        return null;
    }

    querySelectorAll(selector) {
        if (selector !== "trkpt, rtept") {
            return [];
        }

        const nodes = [];
        const regex = /<(trkpt|rtept)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
        let match;
        while ((match = regex.exec(this.xmlText)) !== null) {
            const attrs = parseAttributes(match[2]);
            nodes.push(new MockTrackPointNode(attrs, match[3]));
        }
        return nodes;
    }
}

export function installDomParserPolyfill() {
    if (typeof globalThis.DOMParser !== "undefined") {
        return;
    }

    globalThis.DOMParser = class DOMParser {
        parseFromString(xmlText) {
            return new MockXmlDocument(String(xmlText ?? ""));
        }
    };
}
