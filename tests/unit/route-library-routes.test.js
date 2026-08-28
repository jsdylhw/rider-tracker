import { createAgentUnavailableError } from "../../src/server/agent-unavailable.js";
import { createRouteLibraryHandlers } from "../../src/server/routes/route-library-routes.js";
import { assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "route-library-routes",
    tests: [
        {
            name: "preserves browser route operations while delegating every write to Python",
            async run() {
                const calls = [];
                const agentClient = fakeAgentClient(calls);
                const handlers = createRouteLibraryHandlers({ agentClient });

                const listed = response();
                await handlers.list({ query: { source: "gpx" } }, listed);
                const saved = response();
                await handlers.save({ body: { source: "gpx" } }, saved);
                await handlers.get(request("route-1"), response());
                await handlers.rename({ ...request("route-1"), body: { name: "Renamed" } }, response());
                await handlers.saveProgress({ ...request("route-1"), body: { resumeDistanceMeters: 400 } }, response());
                await handlers.clearProgress(request("route-1"), response());
                await handlers.remove(request("route-1"), response());

                assertEqual(listed.statusCode, 200);
                assertEqual(listed.payload.ok, true);
                assertEqual(saved.statusCode, 201);
                assertEqual(calls.map((item) => item.name).join(","),
                    "list,save,get,rename,saveProgress,clearProgress,remove");
                assertEqual(calls[0].value.source, "gpx");
                assertEqual(calls[3].value.name, "Renamed");
                assertEqual(calls[4].value.resumeDistanceMeters, 400);
            }
        },
        {
            name: "preserves upstream errors and emits structured backend degradation",
            async run() {
                const badRequest = new Error("Route name is required.");
                badRequest.statusCode = 400;
                const invalid = response();
                await createRouteLibraryHandlers({
                    agentClient: { saveRoute: async () => { throw badRequest; } }
                }).save({ body: {} }, invalid);

                const unavailable = response();
                await createRouteLibraryHandlers({
                    agentClient: {
                        listSavedRoutes: async () => {
                            throw createAgentUnavailableError("无法连接本地 Training Agent。");
                        }
                    }
                }).list({ query: {} }, unavailable);

                assertEqual(invalid.statusCode, 400);
                assertEqual(invalid.payload.error, "Route name is required.");
                assertEqual(unavailable.statusCode, 503);
                assertEqual(unavailable.payload.code, "agent_unavailable");
                assertEqual(unavailable.payload.capability, "route_library");
            }
        }
    ]
};

function fakeAgentClient(calls) {
    const record = (name, value) => {
        calls.push({ name, value });
        return Promise.resolve(name === "list" ? { routes: [] } : { route: { id: "route-1" } });
    };
    return {
        listSavedRoutes: (value) => record("list", value),
        saveRoute: (value) => record("save", value),
        getSavedRoute: (value) => record("get", value),
        renameSavedRoute: (id, name) => record("rename", { id, name }),
        deleteSavedRoute: (value) => record("remove", value),
        saveRouteProgress: (id, value) => record("saveProgress", { id, ...value }),
        clearRouteProgress: (value) => record("clearProgress", value)
    };
}

function request(routeId) {
    return { params: { routeId } };
}

function response() {
    return {
        statusCode: 0,
        payload: null,
        status(value) {
            this.statusCode = value;
            return this;
        },
        json(value) {
            this.payload = value;
            return this;
        }
    };
}
