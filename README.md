# Rider Tracker 🚴‍♂️

## Overview / 项目简介
Rider Tracker 是一个基于浏览器的虚拟骑行平台，支持导入 GPX 路线、连接蓝牙设备（心率带/功率计/骑行台）、进行实时骑行与离线模拟，并导出 FIT/JSON 数据。项目同时提供沉浸式街景骑行和 PiP 悬浮窗能力。  
Rider Tracker is a browser-based virtual cycling platform. It supports GPX route import, Bluetooth device connection (HR monitor / power meter / trainer), real-time riding and offline simulation, plus FIT/JSON export. It also includes immersive Street View mode and a PiP overlay.

---

## Quick Start / 快速启动
由于 Web Bluetooth 的安全限制，请通过本地服务器启动，不要直接双击 HTML 文件。  
Due to Web Bluetooth security requirements, run the project through a local server (do not open the HTML file directly).

```bash
# Python
python -m http.server 8000

# Node.js
npx http-server -p 8000
```

打开浏览器访问（Open in browser）:  
[http://localhost:8000](http://localhost:8000)

---

## How To Use / 使用方法

### 1) 路线设置 | Route Setup
支持手工分段路线和 GPX 导入。  
You can build routes manually or import GPX files.

### 2) 离线模拟 | Offline Simulation
输入功率后运行模拟，快速得到全程速度/时间结果。  
Run a full-route simulation with target power to estimate speed and completion time.

### 3) 实时骑行 | Live Ride
连接心率带和功率计后开始骑行；可选连接骑行台启用训练控制。  
Connect HR and power devices, then start riding; optionally connect a trainer for control modes.

### 4) 沉浸街景 | Immersive Street View
在骑行界面输入 Google API Key，加载街景后可进入沉浸模式。  
Enter Google API key in the live dashboard, load Street View, then enter immersive mode.

### 5) 数据导出 | Data Export
骑行后可导出 FIT 或 JSON。  
Export ride data as FIT or JSON after a ride.

---

## Compatibility / 兼容性
- **操作系统 / OS:** Windows 10/11, macOS
- **浏览器 / Browser:** Chromium-based browsers (Chrome/Edge latest recommended)
- **不支持 / Not Supported:** Safari, Firefox (limited Web Bluetooth / Document PiP support)

---

## Notes / 说明
- 项目目前为前端主导架构，适合本地训练与功能验证。  
- This project is currently frontend-first and optimized for local training and feature validation.
