import {
    buildRoadGraph,
    buildBoundsAroundRoute,
    buildOverpassRoadQuery,
    buildSyntheticGridRoadNetwork,
    chooseExplorationEdge,
    extendOsmRoute,
    planOsmRoute
} from "../../src/domain/route/osm-road-network.js";
import { assert, assertEqual, assertGreaterThan } from "../helpers/test-harness.js";

const SIMPLE_OVERPASS = {
    elements: [
        { type: "node", id: 1, lat: 37.0, lon: -122.0 },
        { type: "node", id: 2, lat: 37.0, lon: -121.999 },
        { type: "node", id: 3, lat: 37.001, lon: -121.999 },
        { type: "node", id: 4, lat: 37.001, lon: -121.998 },
        { type: "way", id: 10, tags: { highway: "residential" }, nodes: [1, 2, 3, 4] }
    ]
};

export const suite = {
    name: "osm-road-network",
    tests: [
        {
            name: "builds Overpass road query around selected route bounds",
            run() {
                const bounds = buildBoundsAroundRoute(
                    { lat: 37.0, lng: -122.0 },
                    { lat: 37.001, lng: -121.998 }
                );
                const query = buildOverpassRoadQuery(bounds);

                assertGreaterThan(bounds.sizeKm, 0);
                assert(query.includes("[out:json][timeout:25]"));
                assert(query.includes("residential"));
            }
        },
        {
            name: "plans a sampled OSM route from snapped start to destination",
            run() {
                const graph = buildRoadGraph(SIMPLE_OVERPASS);
                const route = planOsmRoute({
                    graph,
                    start: { lat: 37.0, lng: -122.0 },
                    destination: { lat: 37.001, lng: -121.998 },
                    sampleSpacingMeters: 40
                });

                assertGreaterThan(graph.edges.length, 0);
                assertGreaterThan(route.totalDistanceMeters, 100);
                assertGreaterThan(route.points.length, 2);
                assertEqual(route.points[0].distanceMeters, 0);
                assertEqual(route.points.at(-1).distanceMeters, route.totalDistanceMeters);
            }
        },
        {
            name: "keeps OSM one-way direction and excludes roads prohibited for cycling",
            run() {
                const graph = buildRoadGraph({
                    elements: [
                        { type: "node", id: 1, lat: 37.0, lon: -122.0 },
                        { type: "node", id: 2, lat: 37.0, lon: -121.999 },
                        { type: "node", id: 3, lat: 37.001, lon: -122.0 },
                        { type: "node", id: 4, lat: 37.001, lon: -121.999 },
                        { type: "node", id: 5, lat: 37.002, lon: -122.0 },
                        { type: "node", id: 6, lat: 37.002, lon: -121.999 },
                        { type: "node", id: 7, lat: 37.003, lon: -122.0 },
                        { type: "node", id: 8, lat: 37.003, lon: -121.999 },
                        { type: "node", id: 9, lat: 37.004, lon: -122.0 },
                        { type: "node", id: 10, lat: 37.004, lon: -121.999 },
                        { type: "way", id: 10, tags: { highway: "residential", oneway: "yes" }, nodes: [1, 2] },
                        { type: "way", id: 11, tags: { highway: "residential", oneway: "-1" }, nodes: [3, 4] },
                        { type: "way", id: 12, tags: { highway: "residential", bicycle: "no" }, nodes: [5, 6] },
                        { type: "way", id: 13, tags: { highway: "motorway" }, nodes: [7, 8] },
                        { type: "way", id: 14, tags: { highway: "residential", access: "no", bicycle: "yes" }, nodes: [9, 10] }
                    ]
                });

                assertEqual(graph.edges.length, 4);
                assert(graph.edges.some((edge) => edge.from === 1 && edge.to === 2));
                assert(graph.edges.some((edge) => edge.from === 4 && edge.to === 3));
                assert(!graph.edges.some((edge) => edge.from === 2 && edge.to === 1));
                assert(!graph.edges.some((edge) => edge.wayId === 12));
                assert(!graph.edges.some((edge) => edge.wayId === 13));
                assert(graph.edges.some((edge) => edge.wayId === 14));
            }
        },
        {
            name: "treats roundabouts as one-way unless bicycle travel explicitly overrides it",
            run() {
                const graph = buildRoadGraph({
                    elements: [
                        { type: "node", id: 1, lat: 37.0, lon: -122.0 },
                        { type: "node", id: 2, lat: 37.0, lon: -121.999 },
                        { type: "node", id: 3, lat: 37.001, lon: -121.999 },
                        { type: "way", id: 20, tags: { highway: "residential", junction: "roundabout" }, nodes: [1, 2, 3, 1] },
                        { type: "way", id: 21, tags: { highway: "residential", junction: "roundabout", "oneway:bicycle": "no" }, nodes: [1, 2] }
                    ]
                });

                const implicitRoundaboutEdges = graph.edges.filter((edge) => edge.wayId === 20);
                const bicycleOverrideEdges = graph.edges.filter((edge) => edge.wayId === 21);
                assertEqual(implicitRoundaboutEdges.length, 3);
                assert(!implicitRoundaboutEdges.some((edge) => edge.from === 2 && edge.to === 1));
                assertEqual(bicycleOverrideEdges.length, 2);
                assert(bicycleOverrideEdges.some((edge) => edge.from === 2 && edge.to === 1));
            }
        },
        {
            name: "builds a labeled fallback grid that can still produce a route",
            run() {
                const bounds = buildBoundsAroundRoute(
                    { lat: 37.0, lng: -122.0 },
                    { lat: 37.01, lng: -121.99 }
                );
                const graph = buildRoadGraph(buildSyntheticGridRoadNetwork(bounds));
                const route = planOsmRoute({
                    graph,
                    start: { lat: 37.0, lng: -122.0 },
                    destination: { lat: 37.01, lng: -121.99 }
                });

                assertEqual(graph.synthetic, true);
                assertGreaterThan(route.points.length, 2);
            }
        },
        {
            name: "extends an initial route along the local graph for exploration",
            run() {
                const graph = buildRoadGraph(buildSyntheticGridRoadNetwork(buildBoundsAroundRoute(
                    { lat: 37.0, lng: -122.0 },
                    { lat: 37.01, lng: -121.99 }
                )));
                const initialRoute = planOsmRoute({
                    graph,
                    start: { lat: 37.0, lng: -122.0 },
                    destination: { lat: 37.01, lng: -121.99 }
                });
                const extendedRoute = extendOsmRoute({
                    graph,
                    rawNodes: initialRoute.rawNodes,
                    intersectionCount: 2
                });

                assertGreaterThan(extendedRoute.totalDistanceMeters, initialRoute.totalDistanceMeters);
                assertGreaterThan(extendedRoute.edgesAdded, 0);
                assertEqual(extendedRoute.points.at(-1).distanceMeters, extendedRoute.totalDistanceMeters);
            }
        },
        {
            name: "continues a midpoint destination in the forward road direction",
            run() {
                const graph = buildRoadGraph({
                    elements: [
                        { type: "node", id: 1, lat: 37.0, lon: -122.0 },
                        { type: "node", id: 2, lat: 37.001, lon: -122.0 },
                        { type: "node", id: 3, lat: 37.002, lon: -122.0 },
                        { type: "node", id: 4, lat: 37.001, lon: -122.001 },
                        { type: "node", id: 5, lat: 37.001, lon: -121.999 },
                        { type: "way", id: 10, tags: { highway: "residential" }, nodes: [1, 2, 3] },
                        { type: "way", id: 11, tags: { highway: "residential" }, nodes: [4, 2, 5] }
                    ]
                });
                const initialRoute = planOsmRoute({
                    graph,
                    start: { lat: 37.0001, lng: -122.0 },
                    destination: { lat: 37.0007, lng: -122.0 }
                });
                const extendedRoute = extendOsmRoute({
                    graph,
                    rawNodes: initialRoute.rawNodes,
                    intent: "straight",
                    intersectionCount: 1,
                    stopAtFirstReachedIntersection: true
                });

                assertEqual(initialRoute.rawNodes.at(-1).continueNodeId, 2);
                assertEqual(extendedRoute.rawNodes.at(-1).nodeId, 2);
                assert(!extendedRoute.rawNodes.slice(2).some((node) => node.nodeId === 1), "路线延伸不应折返到道路起点");
                assertGreaterThan(extendedRoute.intersectionsPassed, 0);
            }
        },
        {
            name: "selects the requested left, straight, or right edge at an exploration junction",
            run() {
                const graph = buildRoadGraph({
                    elements: [
                        { type: "node", id: 1, lat: 37.0, lon: -122.0 },
                        { type: "node", id: 2, lat: 37.001, lon: -122.0 },
                        { type: "node", id: 3, lat: 37.002, lon: -122.0 },
                        { type: "node", id: 4, lat: 37.001, lon: -122.001 },
                        { type: "node", id: 5, lat: 37.001, lon: -121.999 },
                        { type: "way", id: 10, tags: { highway: "residential" }, nodes: [1, 2, 3] },
                        { type: "way", id: 11, tags: { highway: "residential" }, nodes: [4, 2, 5] }
                    ]
                });

                assertEqual(chooseExplorationEdge(graph, 2, 0, "left").to, 4);
                assertEqual(chooseExplorationEdge(graph, 2, 0, "straight").to, 3);
                assertEqual(chooseExplorationEdge(graph, 2, 0, "right").to, 5);
            }
        }
    ]
};
