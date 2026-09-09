import { decodePolyline, fetchGoogleBicycleRoute } from "../../src/adapters/maps/google-routes-client.js";
import { assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "google-routes-client",
    tests: [
        {
            name: "requests one bicycle route with ordered intermediate waypoints",
            async run() {
                let request = null;
                const result = await fetchGoogleBicycleRoute({
                    apiKey: "test-key",
                    waypoints: [
                        { lat: 31.2, lng: 121.4 },
                        { lat: 31.21, lng: 121.41 },
                        { lat: 31.22, lng: 121.42 }
                    ],
                    fetchImpl: async (_url, options) => {
                        request = options;
                        return {
                            ok: true,
                            json: async () => ({
                                routes: [{
                                    distanceMeters: 2400,
                                    duration: "620s",
                                    polyline: { encodedPolyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@" }
                                }]
                            })
                        };
                    }
                });
                const body = JSON.parse(request.body);
                assertEqual(body.travelMode, "BICYCLE");
                assertEqual(body.intermediates.length, 1);
                assertEqual(result.distanceMeters, 2400);
                assertEqual(result.path.length, 3);
            }
        },
        {
            name: "decodes Google encoded polylines",
            run() {
                const points = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
                assertEqual(points[0].lat, 38.5);
                assertEqual(points.at(-1).lng, -126.453);
            }
        },
        {
            name: "falls back to an avoid-highway road route when bicycle coverage is unavailable",
            async run() {
                const requests = [];
                const result = await fetchGoogleBicycleRoute({
                    apiKey: "test-key",
                    waypoints: [{ lat: 31.2, lng: 121.4 }, { lat: 31.22, lng: 121.42 }],
                    fetchImpl: async (_url, options) => {
                        requests.push(JSON.parse(options.body));
                        return {
                            ok: true,
                            json: async () => requests.length === 1 ? { routes: [] } : {
                                routes: [{
                                    distanceMeters: 3200,
                                    duration: "540s",
                                    polyline: { encodedPolyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@" }
                                }]
                            }
                        };
                    }
                });

                assertEqual(requests.length, 2);
                assertEqual(requests[1].travelMode, "DRIVE");
                assertEqual(requests[1].routeModifiers.avoidHighways, true);
                assertEqual(result.travelMode, "DRIVE");
            }
        }
    ]
};
