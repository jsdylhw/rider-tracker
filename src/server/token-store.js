import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_STORE_PATH = path.resolve(process.cwd(), "data", "strava-tokens.json");

export function createTokenStore(filePath = DEFAULT_STORE_PATH) {
    async function loadAll() {
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

    async function saveAll(tokensByUser) {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, JSON.stringify(tokensByUser, null, 2), "utf8");
    }

    async function get(userId) {
        const all = await loadAll();
        return all[userId] ?? null;
    }

    async function set(userId, tokenPayload) {
        const all = await loadAll();
        all[userId] = tokenPayload;
        await saveAll(all);
    }

    return {
        get,
        set
    };
}
