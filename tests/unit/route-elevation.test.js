import {
    resolveElevationSource,
    resolveRideGradePercent,
    ROUTE_ELEVATION_SOURCES,
    supportsGradeSimulation
} from "../../src/domain/route/route-elevation.js";
import { assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "route-elevation",
    tests: [
        {
            name: "allows grade simulation only for GPX and Strava elevation",
            run() {
                assertEqual(supportsGradeSimulation(route("gpx", "gpx_embedded")), true);
                assertEqual(supportsGradeSimulation(route("strava", "strava_route")), true);
                assertEqual(supportsGradeSimulation(route("map-drawn", "google_estimated")), false);
                assertEqual(supportsGradeSimulation(route("manual", "manual_defined")), false);
            }
        },
        {
            name: "keeps Google grade out of virtual ride physics",
            run() {
                assertEqual(resolveRideGradePercent(route("gpx", "gpx_embedded"), { gradePercent: 7 }), 7);
                assertEqual(resolveRideGradePercent(route("map-drawn", "google_estimated"), { gradePercent: 7 }), 0);
            }
        },
        {
            name: "infers trusted sources for legacy imported routes",
            run() {
                assertEqual(
                    resolveElevationSource({ source: "gpx", hasElevationData: true }),
                    ROUTE_ELEVATION_SOURCES.GPX_EMBEDDED
                );
                assertEqual(
                    resolveElevationSource({ source: "strava", hasElevationData: true }),
                    ROUTE_ELEVATION_SOURCES.STRAVA_ROUTE
                );
            }
        },
        {
            name: "does not infer trust for Google or unknown elevation",
            run() {
                assertEqual(
                    resolveElevationSource({ source: "map-drawn", hasElevationData: true }),
                    ROUTE_ELEVATION_SOURCES.NONE
                );
                assertEqual(
                    resolveElevationSource({
                        source: "map-drawn",
                        hasElevationData: false,
                        elevationSource: ROUTE_ELEVATION_SOURCES.GOOGLE_ESTIMATED
                    }),
                    ROUTE_ELEVATION_SOURCES.NONE
                );
            }
        }
    ]
};

function route(source, elevationSource) {
    return { source, elevationSource, hasElevationData: true };
}
