export function assert(condition, message) {
    if (!condition) {
        throw new Error(message || "Assertion failed");
    }
}

export function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(message || `Expected ${expected} but received ${actual}`);
    }
}

export function assertApprox(actual, expected, tolerance, message) {
    if (Math.abs(actual - expected) > tolerance) {
        throw new Error(message || `Expected ${actual} to be within ${tolerance} of ${expected}`);
    }
}

export function assertGreaterThan(actual, threshold, message) {
    if (!(actual > threshold)) {
        throw new Error(message || `Expected ${actual} to be greater than ${threshold}`);
    }
}

export function assertLessThan(actual, threshold, message) {
    if (!(actual < threshold)) {
        throw new Error(message || `Expected ${actual} to be less than ${threshold}`);
    }
}

export async function runSuites(suites) {
    const results = [];

    for (const suite of suites) {
        for (const test of suite.tests) {
            const startedAt = performance.now();

            try {
                await test.run();
                results.push({
                    suite: suite.name,
                    test: test.name,
                    status: "passed",
                    durationMs: performance.now() - startedAt
                });
            } catch (error) {
                results.push({
                    suite: suite.name,
                    test: test.name,
                    status: "failed",
                    durationMs: performance.now() - startedAt,
                    error
                });
            }
        }
    }

    return results;
}

export function renderResults(results, mountNode) {
    const passedCount = results.filter((result) => result.status === "passed").length;
    const failed = results.filter((result) => result.status === "failed");

    mountNode.innerHTML = `
        <section class="summary ${failed.length === 0 ? "success" : "failed"}">
            <h1>Rider Tracker Tests</h1>
            <p>通过 ${passedCount} / ${results.length} 个测试</p>
        </section>
        <section class="results">
            ${results.map((result) => `
                <article class="result ${result.status}">
                    <div class="result-head">
                        <strong>${escapeHtml(result.suite)} / ${escapeHtml(result.test)}</strong>
                        <span>${result.status.toUpperCase()} · ${result.durationMs.toFixed(1)}ms</span>
                    </div>
                    ${result.error ? `<pre>${escapeHtml(result.error.stack || result.error.message)}</pre>` : ""}
                </article>
            `).join("")}
        </section>
    `;
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}
