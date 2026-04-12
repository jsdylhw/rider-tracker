import { simulateStep } from "./src/domain/physics/cycling-model.js";

function runTest(power) {
    const settings = {
        mass: 80, // kg
        crr: 0.004,
        cda: 0.32,
        windSpeed: 0,
        restingHr: 60,
        maxHr: 190
    };

    let state = {
        speed: 0,
        distanceMeters: 0,
        elevationMeters: 0,
        ascentMeters: 0,
        heartRate: 60
    };

    let seconds = 0;
    // 模拟跑 10km 平路
    while (state.distanceMeters < 10000 && seconds < 3600) {
        seconds++;
        state = simulateStep({
            ...state,
            power,
            gradePercent: 0,
            elapsedSeconds: seconds,
            settings,
            durationSeconds: 3600,
            dt: 1
        });
    }

    const avgSpeedKph = (state.distanceMeters / seconds) * 3.6;
    console.log(`[Test] Power: ${power}W -> Distance: ${(state.distanceMeters/1000).toFixed(2)}km, Time: ${seconds}s, Avg Speed: ${avgSpeedKph.toFixed(2)} km/h`);
}

console.log("=== Simulation Test ===");
runTest(150);
runTest(180);
runTest(220);
runTest(300);
