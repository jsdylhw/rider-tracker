import { fetchOverpassRoadNetwork } from "../../src/adapters/osm/overpass-client.js";
import { assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "overpass-client",
    tests: [
        {
            name: "submits the Overpass query as form data",
            async run() {
                const requests = [];
                const result = await fetchOverpassRoadNetwork(
                    { south: 1, west: 2, north: 3, east: 4 },
                    {
                        endpoints: ["https://example.test/overpass"],
                        fetchImpl: async (url, options) => {
                            requests.push({ url, options });
                            if (options.method === "POST") {
                                return {
                                    ok: false,
                                    status: 406,
                                    text: async () => "not acceptable"
                                };
                            }
                            return {
                                ok: true,
                                text: async () => JSON.stringify({ elements: [] })
                            };
                        }
                    }
                );

                assertEqual(requests.length, 2);
                assertEqual(requests[0].url, "https://example.test/overpass");
                assertEqual(requests[0].options.headers["Content-Type"], "application/x-www-form-urlencoded;charset=UTF-8");
                assertEqual(requests[0].options.body.get("data").includes("[out:json]"), true);
                assertEqual(requests[1].options.method, "GET");
                assertEqual(requests[1].url.includes("?data="), true);
                assertEqual(result.elements.length, 0);
            }
        }
    ]
};
