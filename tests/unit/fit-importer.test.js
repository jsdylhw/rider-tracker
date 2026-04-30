import { exportSessionAsFit } from "../../src/adapters/export/fit-exporter.js";
import { buildSessionFromFitMessages, importFitActivity } from "../../src/adapters/fit/fit-importer.js";
import { assert, assertApprox, assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "fit-importer",
    tests: [
        {
            name: "builds an analysable session from FIT record messages",
            run() {
                const startedAt = new Date("2026-04-30T08:00:00Z");
                const { session, activity } = buildSessionFromFitMessages({
                    fileName: "morning-ride.fit",
                    settings: {
                        ftp: 250,
                        maxHr: 182,
                        restingHr: 58
                    },
                    messages: {
                        recordMesgs: [
                            {
                                timestamp: new Date(startedAt.getTime() + 1000),
                                distance: 100,
                                speed: 10,
                                power: 180,
                                heartRate: 140,
                                cadence: 86,
                                altitude: 101,
                                grade: 1.2,
                                positionLat: toSemicircles(31.2),
                                positionLong: toSemicircles(121.4)
                            },
                            {
                                timestamp: new Date(startedAt.getTime() + 3000),
                                distance: 300,
                                speed: 12,
                                power: 220,
                                heartRate: 150,
                                cadence: 90,
                                altitude: 105,
                                grade: 2.5,
                                positionLat: toSemicircles(31.2005),
                                positionLong: toSemicircles(121.4005)
                            },
                            {
                                timestamp: startedAt,
                                distance: 0,
                                speed: 8,
                                power: 160,
                                heartRate: 130,
                                cadence: 82,
                                altitude: 100,
                                grade: 0,
                                positionLat: toSemicircles(31.1995),
                                positionLong: toSemicircles(121.3995)
                            }
                        ]
                    }
                });

                assertEqual(session.source, "fit-import");
                assertEqual(session.exportMetadata.activityName, "morning-ride");
                assertEqual(session.records.length, 3);
                assertEqual(session.records[0].elapsedSeconds, 0);
                assertEqual(session.records[2].elapsedSeconds, 3);
                assertApprox(session.records[2].distanceKm, 0.3, 0.0001);
                assertApprox(session.records[2].speedKph, 43.2, 0.0001);
                assertApprox(session.records[1].positionLat, 31.2, 0.0001);
                assertApprox(session.records[2].routeProgress, 1, 0.0001);
                assertEqual(session.summary.metrics.power.averageWatts, 187);
                assertEqual(session.summary.metrics.heartRate.maxBpm, 150);
                assertEqual(session.route.points.length, 3);
                assert(activity.rawSession === session, "activity 应引用导入后的 session");
            }
        },
        {
            name: "rejects FIT messages without records",
            run() {
                let errorMessage = "";
                try {
                    buildSessionFromFitMessages({
                        messages: {
                            sessionMesgs: [{ sportProfileName: "Empty Ride" }]
                        }
                    });
                } catch (error) {
                    errorMessage = error.message;
                }

                assert(errorMessage.includes("没有 record 数据"));
            }
        },
        {
            name: "imports a generated virtual ride FIT file",
            async run() {
                const fitBytes = await exportSessionAsFit(buildVirtualRideSession(), {
                    activityName: "Generated Test Ride"
                }, {
                    markVirtualActivity: true
                });
                const { session, activity } = await importFitActivity(fitBytes, {
                    fileName: "generated-test-ride.fit",
                    settings: { ftp: 250 }
                });

                assertEqual(session.records.length, 3);
                assertApprox(session.summary.metrics.ride.distanceKm, 0.3, 0.0001);
                assertEqual(session.summary.metrics.ride.elapsedSeconds, 3);
                assertEqual(session.summary.metrics.power.averageWatts, 187);
                assertEqual(session.summary.metrics.heartRate.averageBpm, 140);
                assert(activity.name.includes("Rider Tracker"), "应从生成的 FIT 会话信息中恢复活动名称");
            }
        }
    ]
};

function buildVirtualRideSession() {
    const startedAt = "2026-04-30T08:00:00.000Z";
    return {
        createdAt: "2026-04-30T08:00:03.000Z",
        startedAt,
        finishedAt: "2026-04-30T08:00:03.000Z",
        route: {
            name: "Generated Test Ride",
            totalDistanceMeters: 300,
            totalAscentMeters: 5
        },
        summary: {
            metrics: {
                ride: {
                    elapsedSeconds: 3,
                    distanceKm: 0.3,
                    ascentMeters: 5,
                    routeProgress: 1
                },
                speed: {
                    averageKph: 360,
                    maxKph: 43.2
                },
                power: {
                    averageWatts: 187,
                    maxWatts: 220
                },
                heartRate: {
                    averageBpm: 140,
                    maxBpm: 150
                },
                grade: {
                    averagePercent: 1.2,
                    averagePositivePercent: 1.2,
                    averageNegativePercent: 0,
                    maxPositivePercent: 2.5,
                    maxNegativePercent: 0
                }
            }
        },
        records: [
            {
                elapsedSeconds: 0,
                distanceKm: 0,
                speedKph: 28.8,
                power: 160,
                heartRate: 130,
                cadence: 82,
                elevationMeters: 100,
                ascentMeters: 0,
                gradePercent: 0,
                positionLat: 31.1995,
                positionLong: 121.3995
            },
            {
                elapsedSeconds: 1,
                distanceKm: 0.1,
                speedKph: 36,
                power: 180,
                heartRate: 140,
                cadence: 86,
                elevationMeters: 101,
                ascentMeters: 1,
                gradePercent: 1.2,
                positionLat: 31.2,
                positionLong: 121.4
            },
            {
                elapsedSeconds: 3,
                distanceKm: 0.3,
                speedKph: 43.2,
                power: 220,
                heartRate: 150,
                cadence: 90,
                elevationMeters: 105,
                ascentMeters: 5,
                gradePercent: 2.5,
                positionLat: 31.2005,
                positionLong: 121.4005
            }
        ],
        exportMetadata: {
            activityName: "Generated Test Ride",
            markVirtualActivity: true
        }
    };
}

function toSemicircles(degrees) {
    return Math.round((degrees * 2147483648) / 180);
}
