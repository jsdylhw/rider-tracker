import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "data", "strava-config.json");

export function createConfigStore(filePath = DEFAULT_CONFIG_PATH) {
    async function load() {
        try {
            const content = await fs.readFile(filePath, "utf8");
            return JSON.parse(content);
        } catch (error) {
            if (error.code === "ENOENT") {
                return {};
            }
            throw error;
        }
    }

    async function save(patch) {
        const current = await load();
        const next = { ...current, ...patch };
        Object.keys(next).forEach((key) => {
            if (next[key] === null || next[key] === undefined || next[key] === "") {
                delete next[key];
            }
        });

        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, JSON.stringify(next, null, 2), "utf8");
        return next;
    }

    return {
        filePath,
        load,
        save
    };
}
