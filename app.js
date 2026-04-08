const connectHrBtn = document.getElementById('connectHrBtn');
const connectPowerBtn = document.getElementById('connectPowerBtn');
const pipBtn = document.getElementById('pipBtn');
const heartRateDisplay = document.getElementById('heartRateDisplay');
const powerDisplay = document.getElementById('powerDisplay');
const statusText = document.getElementById('statusText');

// 全局状态，用于同步数据到悬浮窗
window.currentData = {
    hr: '--',
    power: '--',
    time: '00:00',
    np: '--'
};

// 悬浮窗配置状态
window.pipConfig = {
    hr: true,
    power: true,
    time: false,
    np: false
};

// 监听多选框变化
document.querySelectorAll('.checkbox-group input').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
        window.pipConfig[e.target.value] = e.target.checked;
        if (typeof window.reRenderPiP === 'function') {
            window.reRenderPiP(); // 如果悬浮窗已开启，实时重建DOM
        }
    });
});

// ================= 模拟时间计时器 =================
let rideSeconds = 0;
setInterval(() => {
    // 只有当连接了任一设备时才开始计时
    if (window.currentData.hr !== '--' || window.currentData.power !== '--') {
        rideSeconds++;
        const mins = String(Math.floor(rideSeconds / 60)).padStart(2, '0');
        const secs = String(rideSeconds % 60).padStart(2, '0');
        window.currentData.time = `${mins}:${secs}`;
        
        // 尝试更新悬浮窗里的时间
        if (typeof window.updatePiPData === 'function') {
            window.updatePiPData();
        }
    }
}, 1000);

// 蓝牙特征值配置 - 心率
const HR_SERVICE = 'heart_rate';
const HR_MEASUREMENT_CHAR = 'heart_rate_measurement';

// 蓝牙特征值配置 - 功率 (Cycling Power)
const POWER_SERVICE = 'cycling_power';
const POWER_MEASUREMENT_CHAR = 'cycling_power_measurement';

// 检查是否可以启用悬浮窗
function checkPiPAvailability() {
    if ('documentPictureInPicture' in window) {
        pipBtn.disabled = false;
    } else {
        statusText.innerText += ' ⚠️ 浏览器不支持 Document PiP。';
    }
}

// ================= 连接心率带 =================
connectHrBtn.addEventListener('click', async () => {
    try {
        statusText.innerText = '正在搜索蓝牙心率设备...';
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [HR_SERVICE] }]
        });

        statusText.innerText = `正在连接: ${device.name}...`;
        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(HR_SERVICE);
        const characteristic = await service.getCharacteristic(HR_MEASUREMENT_CHAR);
        
        await characteristic.startNotifications();
        
        statusText.innerText = `✅ 已连接心率带: ${device.name}`;
        connectHrBtn.innerText = '已连接心率';
        connectHrBtn.style.backgroundColor = 'var(--primary-hover)';
        
        checkPiPAvailability();
        characteristic.addEventListener('characteristicvaluechanged', handleHeartRateMeasurement);

        device.addEventListener('gattserverdisconnected', () => {
            statusText.innerText = '❌ 心率带已断开';
            updateHeartRateUI('--');
            connectHrBtn.innerText = '连接心率带';
            connectHrBtn.style.backgroundColor = 'var(--primary)';
        });
    } catch (error) {
        console.error('心率带连接失败', error);
        statusText.innerText = `连接失败: ${error.message}`;
    }
});

// ================= 连接功率计 =================
connectPowerBtn.addEventListener('click', async () => {
    try {
        statusText.innerText = '正在搜索蓝牙功率计...';
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [POWER_SERVICE] }]
        });

        statusText.innerText = `正在连接: ${device.name}...`;
        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(POWER_SERVICE);
        const characteristic = await service.getCharacteristic(POWER_MEASUREMENT_CHAR);
        
        await characteristic.startNotifications();
        
        statusText.innerText = `✅ 已连接功率计: ${device.name}`;
        connectPowerBtn.innerText = '已连接功率';
        connectPowerBtn.style.backgroundColor = '#ffa502';
        connectPowerBtn.style.color = 'white';
        
        checkPiPAvailability();
        characteristic.addEventListener('characteristicvaluechanged', handlePowerMeasurement);

        device.addEventListener('gattserverdisconnected', () => {
            statusText.innerText = '❌ 功率计已断开';
            updatePowerUI('--');
            connectPowerBtn.innerText = '连接功率计';
            connectPowerBtn.style.backgroundColor = '#eccc68';
            connectPowerBtn.style.color = '#2f3542';
        });
    } catch (error) {
        console.error('功率计连接失败', error);
        statusText.innerText = `连接失败: ${error.message}`;
    }
});

// ================= 数据解析与更新 =================
function handleHeartRateMeasurement(event) {
    const value = event.target.value;
    const flags = value.getUint8(0);
    const rate16Bits = flags & 0x1;
    const heartRate = rate16Bits ? value.getUint16(1, true) : value.getUint8(1);
    updateHeartRateUI(heartRate);
}

function handlePowerMeasurement(event) {
    const value = event.target.value;
    // Cycling Power 协议: 功率值通常在第2和第3个字节 (16位整数，小端序)
    // 第1、2字节是Flags
    const power = value.getInt16(2, true);
    updatePowerUI(power);
}

function updateHeartRateUI(hr) {
    window.currentData.hr = hr;
    heartRateDisplay.innerHTML = `${hr} <span class="unit">bpm</span>`;
    if (typeof window.updatePiPData === 'function') {
        window.updatePiPData();
    }
}

function updatePowerUI(power) {
    window.currentData.power = power;
    powerDisplay.innerHTML = `${power} <span class="unit">W</span>`;
    if (typeof window.updatePiPData === 'function') {
        window.updatePiPData();
    }
}
