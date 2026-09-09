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
                const productionFiles = [
                    ...javascriptFiles(path.join(PROJECT_ROOT, "src", "server")),
                    path.join(PROJECT_ROOT, "scripts", "database-preflight.js")
                ];
                const offenders = productionFiles
                    .filter((file) => fs.readFileSync(file, "utf8").includes("node:sqlite"));
                assertEqual(offenders.length, 0);
            }
        },
        {
            name: "keeps legacy athlete profile migration out of the Node server",
            run() {
                const source = fs.readFileSync(path.join(PROJECT_ROOT, "src", "server", "index.js"), "utf8");
                assertEqual(source.includes("user-profile.json"), false);
                assertEqual(source.includes("readUserProfile"), false);
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
