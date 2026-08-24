# Rider Tracker

Rider Tracker 是一个本地运行的智能虚拟骑行平台。它可以导入 GPX 路线、连接蓝牙骑行设备、按路线进行实时骑行或离线模拟，也可以通过内置 Training Agent 进行活动分析、训练建议和路线规划。

## 怎么用

Windows 用户可以直接双击：

```text
start-windows.bat
```

它会检查 Node.js 版本、安装依赖、启动本地服务，并自动打开浏览器。

首次安装 Node 和 Training Agent 依赖：

```bash
npm install
npm run setup:agent
```

将根目录的 `config.yaml.example` 复制为 `config.yaml`，只填写需要使用的 Rider、模型、Garmin、Strava、高德或 Google 配置。Node 和 Python 共用这一份配置；真实配置和本地 Token 均被 Git 忽略。

首次创建数据库：

```bash
npm run db:init
```

从旧版 Rider 数据库升级时只需显式执行一次：

```bash
npm run db:migrate
```

`npm start` 不会重复迁移数据库，只检查已初始化的共享结构。需要排查结构时可运行 `npm run db:check`。

统一启动 Rider 和 Training Agent：

```bash
npm start
```

打开浏览器：

```text
http://127.0.0.1:8787
```

停止服务：

```text
Ctrl + C
```

运行测试：

```bash
npm test
```

`npm start` 会先启动内置 Python Training Agent，健康检查通过后再启动 Rider Node 服务。注意不要直接双击 `index.html`；Web Bluetooth、本地活动历史、FIT 文件保存、Agent 和 Strava 上传都依赖本地服务。

需要单独排查服务时可以使用：

```bash
npm run start:rider
npm run start:agent
```

## 主要功能

### FIT 活动导入与分析

- 首页可以导入本地 `.fit` 文件。
- 导入后会进入活动详情页。
- 原始 FIT 文件会保存到 `data/files/fit/`。
- Training Agent 使用同一条确定性入口解析 FIT，并保存活动摘要、事实和有版本的详情序列缓存。
- 打开详情时优先读取 `activity_artifacts`；只有 FIT 内容或契约版本变化时才重新解析原始文件。

### 活动历史

- 首页显示最近活动。
- 支持打开详情、改名、删除。
- 删除活动时会同步删除对应的本地 FIT 文件。
- 活动摘要保存在 SQLite：

```text
data/rider-tracker.db
```

### GPX 路线

- 支持手工分段路线。
- 支持导入 GPX。
- 会基于路线生成距离、海拔、坡度数据。
- 实时骑行时可以按路线推进位置。

### 我的路线

- AI 路线最终确认、GPX 导入会自动保存到 SQLite 路线库；地图生成路线可点击“保存当前路线”。
- 已保存路线可以从起点加载，也可以从上次中断里程继续；骑完整条路线后会自动清除继续进度。
- 路线几何与可变进度分别保存在 `saved_routes`、`route_progress`，完成活动会记录所用路线及起止里程。
- 相同几何重复保存会复用已有路线资产，不依赖原 AI 对话或原 GPX 文件重新打开。

### AI 虚拟路线

- “实时骑行设置 → AI 路线”可以通过对话请求 Personal FIT Agent 生成 2-3 条路线候选。
- 候选使用同一张 Rider 地图预览；预览草稿不能直接开骑，点击“最终确认”后才会成为可骑行路线。
- 后续对话会基于当前计划增量修改，不会默认重新进行宽泛路线发现；也可以直接反转或撤销当前路线。
- 国内路线可以查询附近的 Strava 路段，在页面中按骑行顺序选择 1-3 个路段，再由 Agent 拼接起点、路段和终点之间的连接路线。
- AI 路线草稿、当前候选和确认状态会保存在浏览器及 Agent 会话中，刷新页面后可继续处理。
- AI 虚拟路线不请求海拔，坡度按 `0%` 处理，适合与 ERG 课表组合使用。
- 页面中的预计时间按虚拟骑行 `25 km/h` 估算，不沿用地图服务偏保守的城市骑行耗时。
- 需要真实坡度模拟时，请继续导入带海拔的 GPX/Strava 路线；Agent 不伪造坡度数据。

Training Agent 已位于 `services/training-agent/`，不再要求并排启动另一个源码仓。Rider 默认通过内部代理连接 `http://127.0.0.1:8000`。监听地址、端口、数据库、模型和外部平台配置都在根目录 `config.yaml` 中维护。

环境变量仍可作为临时覆盖，例如连接另一个 Agent 实例：

```text
PERSONAL_FIT_AGENT_URL=http://127.0.0.1:8000
PERSONAL_FIT_AGENT_TOKEN=对应的 web_api_token
```

Token 仅由 Rider Node 服务读取，不会发送给浏览器。

## 项目结构与测试

浏览器只访问 Rider Node；Node 负责实时骑行、设备控制和页面，并代理 Agent 请求。`services/training-agent/` 中的 Python 服务负责对话、活动分析、工作流和路线规划。两者仍是独立进程，避免模型调用影响 FTMS 实时控制。

```text
浏览器 -> Rider Node :8787 -> Training Agent Python :8000
```

运行测试：

```bash
npm test                  # Rider 单元与本地集成测试
npm run test:agent        # Training Agent pytest
npm run test:integration  # 启动两个真实进程，验证 Rider -> Agent 代理链路
npm run test:all          # 依次运行以上测试
```

这些默认测试不执行真实 Garmin 下载或 Strava 上传。真实账号、地图服务和上传链路应作为显式在线验收单独运行。

配置 Garmin 后，可通过统一入口同步并索引最近活动：

```bash
npm run agent:cli -- sync-garmin --count 10
```

### 离线模拟

- 输入骑手参数和恒定功率。
- 按整条路线模拟速度、时间、距离、爬升。
- 生成 session records 和 summary。
- 支持导出 JSON / FIT。

### 实时虚拟骑行

- 支持连接心率带。
- 支持连接功率计。
- 支持连接 FTMS 骑行台。
- 支持固定阻力、ERG 固定功率、路线坡度模拟。
- 支持自定义 ERG 分段训练目标。

### Dashboard / PiP / 街景

- 实时 Dashboard 展示功率、速度、心率、踏频、坡度等数据。
- 支持 PiP 悬浮窗。
- 支持 Google Street View 沉浸模式。

### FIT 导出与 Strava 上传

- 模拟或实时骑行结束后可以导出 FIT。
- 可以连接 Strava 后上传 FIT。
- Strava 配置可以通过本地页面保存。

## 本地数据

运行数据默认在：

```text
data/
```

常见文件：

```text
user-profile.json             根目录个人基础数据，不提交到仓库
data/rider-tracker.db       SQLite 活动历史数据库
data/files/fit/             本地保存的 FIT 文件
data/strava-config.json     Strava app 配置
data/strava-tokens.json     Strava OAuth token
```

`user-profile.json` 和 `data/` 不提交到仓库。

## Strava 配置

不配置 Strava 也可以使用 GPX、FIT 导入、模拟、实时骑行、本地历史和 FIT 导出。

如需上传 Strava，启动服务后打开：

```text
http://127.0.0.1:8787/strava/login
```

或在页面里点击连接 Strava。

Strava callback URL：

```text
http://localhost:8787/api/strava/auth/callback
```

## 浏览器兼容

推荐：

- Chrome
- Edge

原因是实时设备连接依赖 Web Bluetooth，PiP 也依赖 Chromium 系浏览器能力。
