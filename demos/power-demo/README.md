# PowerTest Demo

本目录是一个独立 Demo，用来在不影响 `rider_tracker` 主流程的前提下，先调通：

- 连接功率计并读取实时功率/踏频
- 连接 FTMS 骑行台控制点
- 手动调节坡度 `-10% ~ +10%` 并下发到骑行台

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
3. 调整坡度滑杆或数字输入（`-10` 到 `10`）
4. 点击“发送坡度到骑行台”
5. 查看页面日志和设备反馈

另外支持键盘快捷键：

- `ArrowUp`: 坡度 +0.5%
- `ArrowDown`: 坡度 -0.5%

## 技术说明

- 优先下发 FTMS `0x11` (Indoor Bike Simulation Parameters)
- 若 `0x11` 不支持，自动回退 `0x03` (Set Target Inclination)
- 控制点命令采用串行队列，避免并发写导致响应错配
