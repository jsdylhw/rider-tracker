import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertEqual } from "../helpers/test-harness.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const suite = {
    name: "server-architecture",
    tests: [
        {
            name: "keeps production Node server free of direct SQLite ownership",
            run() {
                const offenders = javascriptFiles(path.join(PROJECT_ROOT, "src", "server"))
                    .filter((file) => fs.readFileSync(file, "utf8").includes("node:sqlite"));
                assertEqual(offenders.length, 0);
            }
        }
    ]
};

function javascriptFiles(root) {
    return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        const target = path.join(root, entry.name);
        if (entry.isDirectory()) return javascriptFiles(target);
        return entry.isFile() && entry.name.endsWith(".js") ? [target] : [];
    });
}
