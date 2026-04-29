# Rider Tracker

## Overview / 项目简介

Rider Tracker 是一个本地浏览器虚拟骑行平台，支持导入 GPX 路线、连接蓝牙设备（心率带 / 功率计 / 骑行台）、进行实时骑行与离线模拟，并导出 FIT/JSON 数据。项目现在内置 Node 本地服务器，用于打开前端、管理 Strava OAuth/FIT 上传，以及保存本地活动历史。  
Rider Tracker is a local browser-based virtual cycling platform. It supports GPX route import, Bluetooth devices (HR monitor / power meter / trainer), real-time riding and offline simulation, plus FIT/JSON export. The project now includes a bundled Node server for serving the app, Strava OAuth/FIT upload, and local activity history storage.

---

## Quick Start / 快速启动

由于 Web Bluetooth、Strava OAuth 和本地数据库都需要本地服务器，请从项目根目录启动，不要直接双击 `index.html`。  
Because Web Bluetooth, Strava OAuth, and local history storage depend on the local server, start the app from the project root instead of opening `index.html` directly.

首次运行先安装依赖：

```bash
npm install
```

启动应用：

```bash
npm start
```

Windows PowerShell 如果 `npm` 被拦截，可以用：

```powershell
npm.cmd install
npm.cmd start
```

打开浏览器访问：

```text
http://127.0.0.1:8787
```

也可以访问：

```text
http://localhost:8787
```

正常启动后，终端会保持运行。停止服务按：

```text
Ctrl + C
```

---

## Local Server / 本地服务

`npm start` 实际运行：

```text
node src/server/index.js
```

本地服务提供：

```text
GET  /        -> index.html
GET  /src/*   -> frontend modules and CSS
GET  /api/*   -> Strava, activity history, and upload APIs
```

健康检查：

```bash
curl http://127.0.0.1:8787/healthz
```

默认端口是 `8787`。如需调整，可以创建本地 `.env`：

```env
PORT=8787
HOST=127.0.0.1
APP_BASE_URL=http://localhost:8787
```

---

## How To Use / 使用方法

### 1) 路线设置 | Route Setup

支持手工分段路线和 GPX 导入。  
You can build routes manually or import GPX files.

### 2) 离线模拟 | Offline Simulation

输入骑手参数与恒定功率后运行模拟，快速得到全程速度、时间、爬升和功率/心率估算。  
Run a full-route simulation with rider settings and target power to estimate speed, duration, elevation gain, power, and heart-rate metrics.

### 3) 实时骑行 | Live Ride

连接心率带、功率计和骑行台后开始骑行。支持固定阻力、ERG 固定功率和按路线坡度模拟。  
Connect HR, power, and trainer devices, then start riding. Supported trainer modes include resistance, ERG, and route-grade simulation.

### 4) 沉浸街景 | Immersive Street View

在骑行界面输入 Google Maps API Key，加载街景后可进入沉浸模式。  
Enter a Google Maps API key in the live dashboard, load Street View, then enter immersive mode.

### 5) 数据导出与上传 | Export and Upload

骑行后可导出 JSON/FIT，也可以连接 Strava 后上传 FIT。  
After a ride, export JSON/FIT files or connect Strava and upload FIT files.

### 6) 活动历史 | Activity History

模拟完成或实时骑行结束后，活动会写入本地 SQLite 数据库。首页和骑后区域会显示最近活动，并支持改名和删除。  
Completed simulation and live ride sessions are saved into a local SQLite database. The home page and post-ride panel show recent activities with rename and delete actions.

---

## Strava Setup / Strava 配置

Rider Tracker 可以在没有 Strava 凭证的情况下运行。此时路线导入、模拟、实时骑行、JSON/FIT 导出、本地活动历史仍然可用。  
Rider Tracker works without Strava credentials. Route import, simulation, live riding, JSON/FIT export, and local activity history remain available.

如果看到：

```text
STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET 未配置，授权与上传接口不可用。
```

说明 Strava 授权与上传未启用。

推荐方式是在浏览器中配置。点击 `Connect Strava`，或打开：

```text
http://127.0.0.1:8787/strava/login
```

该页面会把 Client ID 和 Client Secret 保存到：

```text
data/strava-config.json
```

也可以手动创建本地 `.env`：

```env
STRAVA_CLIENT_ID=your_client_id
STRAVA_CLIENT_SECRET=your_client_secret
STRAVA_REDIRECT_URI=http://localhost:8787/api/strava/auth/callback
STRAVA_SCOPES=activity:read_all,activity:write
```

Strava API 应用里的 callback URL 使用：

```text
http://localhost:8787/api/strava/auth/callback
```

---

## Local Data / 本地数据

本地运行数据默认保存在：

```text
data/
```

主要文件：

```text
data/rider-tracker.db       -> SQLite 活动历史数据库
data/files/fit/             -> 本地保存的 FIT 文件
data/strava-config.json     -> 浏览器配置的 Strava app credentials
data/strava-tokens.json     -> Strava OAuth tokens
data/README.md              -> SQLite 查询说明
```

`data/` 已在 `.gitignore` 中，不会提交到仓库。

查看最近活动：

```bash
sqlite3 -header -column data/rider-tracker.db "
select name, sport_type, distance_km, estimated_tss
from activities
order by created_at desc
limit 10;
"
```

也可以通过本地 API 查询：

```bash
curl "http://127.0.0.1:8787/api/activities?limit=10"
```

---

## Tests / 测试

运行测试：

```bash
npm test
```

Windows PowerShell：

```powershell
npm.cmd test
```

---

## Compatibility / 兼容性

- **操作系统 / OS:** Windows 10/11, macOS, Linux
- **浏览器 / Browser:** Chromium-based browsers (Chrome / Edge recommended)
- **不支持 / Not Supported:** Safari, Firefox have limited Web Bluetooth / Document PiP support

---

## Notes / 说明

- `node_modules/` 是 `npm install` 生成的依赖目录，不要手动编辑。
- 本项目是本地单用户工具，当前 SQLite 数据库用于活动历史、后续 Garmin/AI 分析和 Strava 描述生成扩展。
- 如果 `npm start` 立即退出，先确认是否已有服务占用端口：

```bash
curl http://127.0.0.1:8787/healthz
```
