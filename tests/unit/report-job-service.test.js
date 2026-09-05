import { createReportJobService } from "../../src/app/services/report-job-service.js";
import { assertEqual } from "../helpers/test-harness.js";

const id = "a".repeat(32), retryId = "b".repeat(32);
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const view = (status = "running") => ({ kind: "activity_report_job", job_id: id, status,
    total: 2, completed: 1, failed: 1, activities: [{ activity_key: "failed-ride", status: "failed" }] });
function harness(client, initial = "[]") {
    let saved = initial;
    const timers = new Map();
    let serial = 0, changes = 0;
    const options = { client, onChange: () => { changes++; }, storage: { getItem: () => saved, setItem: (_key, value) => { saved = value; } },
        schedule: (callback) => { timers.set(++serial, callback); return serial; },
        unschedule: (timer) => timers.delete(timer), requestId: () => "stable-retry" };
    return { service: createReportJobService(options), options, timers, saved: () => saved, changes: () => changes,
        async tick() { const [key, callback] = timers.entries().next().value; timers.delete(key); callback(); await flush(); } };
}

export const suite = { name: "report-job-service", tests: [
    { name: "exhausted worker recovery retries unfinished items without repeating completed reports", async run() {
        let keys;
        const h = harness({ getReportJob: async (key) => ({ ...view("failed"), job_id: key,
            activities: [{ activity_key: "done", status: "completed" }, { activity_key: "pending", status: "pending" }] }),
            retryReportJob: async (selected) => { keys = selected; return { job_id: retryId }; } });
        h.service.track(id); await flush(); await h.service.action(id, "retry");
        assertEqual(JSON.stringify(keys), '["pending"]'); h.service.destroy();
    } },
    { name: "restores identifiers, polls real progress and stops at terminal state", async run() {
        let status = "running", calls = 0;
        const h = harness({ getReportJob: async () => { calls++; return view(status); } }, JSON.stringify([{ id }]));
        h.service.restore(); await flush();
        assertEqual(h.service.blocks()[0].data.completed, 1);
        assertEqual(h.timers.size, 1);
        assertEqual(h.saved().includes("completed"), false);
        const changes = h.changes(); await h.tick();
        assertEqual(h.changes(), changes);
        status = "partial"; await h.tick();
        assertEqual(h.timers.size, 0);
        assertEqual(calls, 3); h.service.destroy();
    } },
    { name: "connection loss preserves last progress and reconnects; missing jobs stop polling", async run() {
        let fail = false;
        const h = harness({ getReportJob: async () => { if (fail) throw Object.assign(new Error(), { status: fail }); return view(); } });
        h.service.track(id); await flush(); fail = 503; await h.tick();
        assertEqual(h.service.blocks()[0].data.completed, 1);
        assertEqual(Boolean(h.service.blocks()[0].data.connectionError), true);
        fail = 404; await h.tick();
        assertEqual(h.service.blocks()[0].data.missing, true);
        assertEqual(h.timers.size, 0); h.service.destroy();
    } },
    { name: "late responses after clear or destroy cannot restore old cards or polling", async run() {
        let resolve;
        const h = harness({ getReportJob: () => new Promise((r) => { resolve = r; }) });
        h.service.track(id); h.service.clear(); resolve(view()); await flush();
        assertEqual(h.service.blocks().length, 0); assertEqual(h.timers.size, 0);
        h.service.track(id); h.service.destroy(); resolve(view()); await flush();
        assertEqual(h.timers.size, 0);
    } },
    { name: "cancel fetches authoritative terminal detail and stops polling", async run() {
        let status = "running";
        const h = harness({ getReportJob: async () => view(status), cancelReportJob: async () => { status = "cancelled"; } });
        h.service.track(id); await flush(); await h.service.action(id, "cancel");
        assertEqual(h.service.blocks()[0].data.status, "cancelled");
        assertEqual(h.timers.size, 0); h.service.destroy();
    } },
    { name: "uncertain retry keeps request identity across reload and submits only failures", async run() {
        const requests = [];
        const client = { getReportJob: async (key) => ({ ...view("partial"), job_id: key }),
            retryReportJob: async (keys, request) => {
                requests.push({ keys, request });
                if (requests.length === 1) throw new Error("response lost");
                return { job_id: retryId };
            } };
        const h = harness(client); h.service.track(id); await flush(); await h.service.action(id, "retry");
        h.service.destroy();
        const restored = createReportJobService(h.options); restored.restore(); await flush();
        await restored.action(id, "retry"); await flush();
        assertEqual(requests[0].request, requests[1].request);
        assertEqual(JSON.stringify(requests[1].keys), '["failed-ride"]');
        assertEqual(restored.blocks().length, 2);
        await restored.action(id, "retry"); assertEqual(requests.length, 2); restored.destroy();
    } }
] };
