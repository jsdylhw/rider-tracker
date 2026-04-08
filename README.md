# Rider Tracker 🚴‍♂️

一个轻量级的纯 Web 室内骑行应用，支持连接蓝牙心率带、功率计以及智能骑行台（开发中），并通过 Chrome 最新的 Document Picture-in-Picture API 实现**完美置顶悬浮窗**。你可以一边看剧或办公，一边在屏幕角落实时监控自己的骑行数据，并享受自动变阻力的 ERG 课表。

## ✨ 特性
- 🔋 **纯 Web 实现**: 无需安装任何客户端或 APP，即开即用（基于 Web Bluetooth API）。
- 🪟 **原生置顶悬浮窗**: 支持一键将心率、功率等核心数据弹射为系统级置顶悬浮窗。
- 💓 **实时心率监测**: 自动连接标准 BLE 心率设备（UUID: 0x180D）。

## 🚀 如何运行
由于 Web Bluetooth API 和 Document PiP API 出于隐私和安全考虑，**必须在安全上下文 (Secure Context)** 下运行。因此不能直接双击打开本地 HTML 文件，需要启动一个本地服务器。

1. **进入项目目录**:
   在终端或命令行中进入代码所在目录 `rider_tracker`。

2. **启动本地 HTTP 服务**:
   如果你安装了 Python，可以运行：
   ```bash
   python -m http.server 8000
   ```
   *(如果使用 Node.js，也可以运行 `npx http-server`)*

3. **打开浏览器**:
   打开 **最新版的 Chrome 或 Edge 浏览器** (不支持 Safari 和 Firefox)，访问：
   [http://localhost:8000](http://localhost:8000)

## 🖥️ 兼容性
- **操作系统**: Windows 10/11, macOS, Android (部分支持)
- **浏览器**: 仅限基于 Chromium 且版本较新的浏览器 (Chrome 111+, Edge 111+ 等)。

## 🗺️ 开发路线图 (Roadmap)
- [x] 连接 BLE 心率带并读取实时数据
- [x] 实现 Document PiP 置顶心率悬浮窗
- [ ] 连接智能骑行台 (FTMS 协议) 并读取实时功率 (Watts) 和踏频 (Cadence)
- [ ] 实现 ERG 模式控制，通过蓝牙下发 `Set Target Power` 指令
- [ ] 支持解析 `.zwo` 或 `.erg` 骑行课表文件，按时间轴自动变化阻力
