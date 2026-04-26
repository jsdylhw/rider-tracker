# PowerTest Demo

本目录是一个独立 Demo，用来在不影响 `rider_tracker` 主流程的前提下，先调通：

- 连接功率计并读取实时功率/踏频
- 连接 FTMS 骑行台控制点
- 手动调节坡度 `-10% ~ +10%` 并下发到骑行台
- 手动设置 ERG 目标功率并下发到骑行台
- 手动设置固定阻力并下发到骑行台

## 启动方式

请用本地 HTTP 服务打开，不要直接双击 `file://`：

```bash
cd c:\codes\rider_tracker
python -m http.server 8080
```

浏览器访问：

- <http://localhost:8080/demos/power-demo/index.html>

推荐浏览器：最新版 Chrome / Edge（支持 Web Bluetooth）。

## 操作步骤

1. 点击“连接功率计”
2. 点击“连接骑行台 (FTMS)”
3. 调整坡度滑杆或数字输入（`-10` 到 `10`），点击“发送坡度到骑行台”
4. 或调整 ERG 目标功率，点击“发送 ERG 到骑行台”
5. 或调整固定阻力百分比，点击“发送阻力到骑行台”
6. 查看页面日志和设备反馈

另外支持键盘快捷键：

- `ArrowUp`: 坡度 +0.5%
- `ArrowDown`: 坡度 -0.5%
- `PageUp`: ERG 目标功率 +5W
- `PageDown`: ERG 目标功率 -5W
- `Home`: 固定阻力 +1%
- `End`: 固定阻力 -1%

## 技术说明

- 优先下发 FTMS `0x11` (Indoor Bike Simulation Parameters)
- 若 `0x11` 不支持，自动回退 `0x03` (Set Target Inclination)
- ERG 下发 FTMS `0x05` (Set Target Power)，参数为 `SINT16` 目标功率瓦数；默认未收到确认时自动重发一次，重发后仍无确认则本次会话切换为快速下发
- 固定阻力下发 FTMS `0x04` (Set Target Resistance Level)，参数按 `0.1%` 编码；固定阻力不是目标功率，实际功率会随踏频/飞轮速度变化
- 控制点命令采用串行队列，避免并发写导致响应错配
