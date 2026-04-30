import { parseGpx } from "../../src/domain/route/gpx-parser.js";
import { assertEqual, assertGreaterThan } from "../helpers/test-harness.js";

const FIXTURES = [
    "mtlll.gpx"
];

async function readFixture(name) {
    if (typeof window !== "undefined" && typeof fetch === "function") {
        const response = await fetch(`./gpx/${name}`);
        if (!response.ok) {
            throw new Error(`读取测试文件失败: ${name}`);
        }
        return await response.text();
    }

    const [{ readFile }, pathModule] = await Promise.all([
        import("node:fs/promises"),
        import("node:path")
    ]);

    const fixturePath = pathModule.resolve(process.cwd(), "tests", "gpx", name);
    return await readFile(fixturePath, "utf-8");
}

export const suite = {
    name: "gpx-fixtures",
    tests: FIXTURES.map((fileName) => ({
        name: `parse fixture: ${fileName}`,
        async run() {
            const xml = await readFixture(fileName);
            const route = parseGpx(xml);

            assertEqual(route.source, "gpx");
            assertGreaterThan(route.points.length, 1, `${fileName} 至少应有 2 个有效轨迹点`);
            assertGreaterThan(route.totalDistanceMeters, 100, `${fileName} 总里程异常偏小`);
            assertGreaterThan(route.segments.length, 0, `${fileName} 没有生成路段数据`);
        }
    }))
};
