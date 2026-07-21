import {
    buildFtmsIndoorBikeSimulationPacket,
    convertCdaToFtmsCw
} from "../../src/domain/physics/ftms-simulation.js";
import { assertEqual, assertGreaterThan, assertLessThan } from "../helpers/test-harness.js";

export const suite = {
    name: "ftms-simulation",
    tests: [
        {
            name: "converts CdA into FTMS wind resistance coefficient",
            run() {
                const cw = convertCdaToFtmsCw(0.35);
                assertGreaterThan(cw, 0.21);
                assertLessThan(cw, 0.22);
            }
        },
        {
            name: "encodes grade, signed wind, Crr and CdA-derived Cw into 0x11 packet",
            run() {
                const { packet, simulation } = buildFtmsIndoorBikeSimulationPacket({
                    gradePercent: 4.25,
                    windSpeedMps: -3.5,
                    crr: 0.004,
                    cda: 0.35
                });
                const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);

                assertEqual(packet.length, 7);
                assertEqual(view.getUint8(0), 0x11);
                assertEqual(view.getInt16(1, true), -3500);
                assertEqual(view.getInt16(3, true), 425);
                assertEqual(view.getUint8(5), 40);
                assertEqual(view.getUint8(6), 21);
                assertGreaterThan(simulation.cw, 0.21);
                assertLessThan(simulation.cw, 0.22);
            }
        }
    ]
};
