import { createActivityHistoryRenderer } from "../../src/ui/renderers/activity-history-renderer.js";
import { assert, assertEqual } from "../helpers/test-harness.js";
import { createFakeElement } from "../helpers/fake-dom.js";

export const suite = {
    name: "activity-history-renderer",
    tests: [
        {
            name: "reloads with the newest filter when an earlier request is still pending",
            async run() {
                const previousWindow = globalThis.window;
                const previousLocation = globalThis.location;
                const previousFetch = globalThis.fetch;
                const container = createFakeElement();
                const requests = [];
                const firstResponse = createDeferred();
                const secondResponse = createDeferred();

                globalThis.window = { addEventListener() {} };
                globalThis.location = { origin: "http://localhost:8787" };
                globalThis.fetch = (url) => {
                    requests.push(String(url));
                    return requests.length === 1 ? firstResponse.promise : secondResponse.promise;
                };

                try {
                    const renderer = createActivityHistoryRenderer({ containers: [container] });
                    const initialLoad = renderer.refresh();
                    container.dispatch("change", {
                        target: createFilterTarget("sportType", "Ride")
                    });

                    firstResponse.resolve(createHistoryResponse("stale-activity"));
                    await initialLoad;
                    await flushAsyncWork();

                    assertEqual(requests.length, 2);
                    assert(requests[1].includes("sportType=Ride"), "最新筛选必须用于重载请求");

                    secondResponse.resolve(createHistoryResponse("ride-activity"));
                    await flushAsyncWork();

                    assert(container.innerHTML.includes("ride-activity"), "最新响应应渲染到活动列表");
                    assert(!container.innerHTML.includes("stale-activity"), "过期响应不能覆盖最新筛选结果");
                } finally {
                    globalThis.window = previousWindow;
                    globalThis.location = previousLocation;
                    globalThis.fetch = previousFetch;
                }
            }
        }
    ]
};

function createFilterTarget(filterKey, value) {
    return {
        value,
        dataset: { activityFilter: filterKey },
        closest(selector) {
            return selector === "[data-activity-filter]" ? this : null;
        }
    };
}

function flushAsyncWork() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function createHistoryResponse(id) {
    return {
        ok: true,
        async json() {
            return {
                ok: true,
                summary: {},
                activities: [{
                    id,
                    name: id,
                    source: "fit-import",
                    sportType: "Ride",
                    startedAt: "2026-07-21T00:00:00.000Z"
                }],
                page: { total: 1, offset: 0, limit: 20, hasMore: false }
            };
        }
    };
}

function createDeferred() {
    let resolve;
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}
