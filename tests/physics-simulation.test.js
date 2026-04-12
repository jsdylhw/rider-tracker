import { simulateStep } from "../src/domain/physics/cycling-model.js";

// A minimal test runner
function runTest(power, gradePercent, distanceKm) {
    const settings = {
        mass: 80, // 骑手 + 自行车总重 (kg)
        crr: 0.004, // 滚动阻力系数
        cda: 0.32, // 空气阻力面积
        windSpeed: 0,
        restingHr: 60,
        maxHr: 190
    };

    let state = {
        speed: 0,
        distanceMeters: 0,
        elevationMeters: 0,
        ascentMeters: 0,
        heartRate: settings.restingHr
    };

    let seconds = 0;
    const targetDistanceMeters = distanceKm * 1000;
    
    // 我们限制最多跑 2 个小时 (7200秒) 以免遇到死循环
    while (state.distanceMeters < targetDistanceMeters && seconds < 7200) {
        seconds++;
        state = simulateStep({
            ...state,
            power,
            gradePercent,
            elapsedSeconds: seconds,
            settings,
            durationSeconds: 7200,
            dt: 1
        });
    }

    const avgSpeedKph = (state.distanceMeters / seconds) * 3.6;
    const finalSpeedKph = state.speed * 3.6;
    
    console.log(`测试结果 | 距离: ${distanceKm}km, 坡度: ${gradePercent}%, 功率: ${power}W`);
    console.log(`  -> 总用时: ${formatDuration(seconds)}`);
    console.log(`  -> 平均速度: ${avgSpeedKph.toFixed(2)} km/h`);
    console.log(`  -> 最终巡航速度: ${finalSpeedKph.toFixed(2)} km/h`);
    console.log('--------------------------------------------------');
}

function formatDuration(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

console.log("================ 物理引擎模拟测试 ================\n");

// 测试场景 1: 10km 平路不同功率
console.log("=== 场景 1: 10km 平路 (0%) ===");
runTest(150, 0, 10);
runTest(180, 0, 10);
runTest(220, 0, 10);
runTest(300, 0, 10);

// 测试场景 2: 10km 缓坡
console.log("\n=== 场景 2: 10km 缓坡 (3%) ===");
runTest(180, 3, 10);
runTest(220, 3, 10);

// 测试场景 3: 10km 下坡
console.log("\n=== 场景 3: 10km 下坡 (-3%) ===");
runTest(180, -3, 10);
runTest(220, -3, 10);
runTest(0, -3, 10); // 溜车
