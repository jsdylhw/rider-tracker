import { buildRoadGraph, buildBoundsAroundRoute, buildOverpassRoadQuery, planOsmRoute } from "../../src/domain/route/osm-road-network.js";
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
        }
    ]
};
