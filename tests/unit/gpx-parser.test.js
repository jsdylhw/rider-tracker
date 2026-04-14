import { parseGpx } from "../../src/domain/route/gpx-parser.js";
import { assertApprox, assertEqual, assertGreaterThan, assertLessThan } from "../helpers/test-harness.js";

const BASIC_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Basic Route</name>
    <trkseg>
      <trkpt lat="31.2304" lon="121.4737"><ele>10</ele></trkpt>
      <trkpt lat="31.2314" lon="121.4747"><ele>20</ele></trkpt>
      <trkpt lat="31.2324" lon="121.4757"><ele>40</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

const NAMESPACED_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <trk>
    <name>Namespaced Route</name>
    <trkseg>
      <trkpt lat="30.0" lon="120.0">
        <ele>5</ele>
        <gpxtpx:TrackPointExtension></gpxtpx:TrackPointExtension>
      </trkpt>
      <trkpt lat="30.001" lon="120.002"><ele>12</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

const NO_ELEVATION_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.0" creator="test" xmlns="http://www.topografix.com/GPX/1/0">
  <trk>
    <name>No Elevation Route</name>
    <trkseg>
      <trkpt lat="32.05539" lon="118.87645"></trkpt>
      <trkpt lat="32.05542" lon="118.87638"></trkpt>
      <trkpt lat="32.05556" lon="118.87613"></trkpt>
      <trkpt lat="32.057198" lon="118.873927"></trkpt>
    </trkseg>
  </trk>
</gpx>`;

export const suite = {
    name: "gpx-parser",
    tests: [
        {
            name: "parseGpx builds route with geo points and total distance",
            run() {
                const route = parseGpx(BASIC_GPX);

                assertEqual(route.source, "gpx");
                assertEqual(route.name, "Basic Route");
                assertEqual(route.segments.length, 1);
                assertGreaterThan(route.totalDistanceMeters, 200);
                assertEqual(route.points[0].distanceMeters, 0);
                assertApprox(route.points.at(-1).elevationMeters, 35, 5.5);
            }
        },
        {
            name: "parseGpx handles XML namespaces and keeps valid coordinates",
            run() {
                const route = parseGpx(NAMESPACED_GPX);

                assertEqual(route.name, "Namespaced Route");
                assertEqual(route.points.length, 2);
                assertApprox(route.points[1].latitude, 30.001, 0.000001);
                assertApprox(route.points[1].longitude, 120.002, 0.000001);
            }
        },
        {
            name: "parseGpx keeps zero elevation and zero grade when GPX has no elevation data",
            run() {
                const route = parseGpx(NO_ELEVATION_GPX);

                assertEqual(route.hasElevationData, false);
                assertEqual(route.totalElevationGainMeters, 0);
                assertEqual(route.totalDescentMeters, 0);
                assertEqual(route.segments[0].gradePercent, 0);
                assertEqual(route.points[0].elevationMeters, 0);
                assertLessThan(Math.max(...route.points.map((point) => Math.abs(point.gradePercent))), 0.001);
            }
        },
        {
            name: "parseGpx rejects files without enough valid track points",
            run() {
                let message = "";

                try {
                    parseGpx(`<?xml version="1.0"?><gpx><trk><trkseg><trkpt lat="31" lon="121"></trkpt></trkseg></trk></gpx>`);
                } catch (error) {
                    message = error.message;
                }

                assertEqual(message, "GPX 文件至少需要包含两个有效轨迹点");
            }
        }
    ]
};
