# Rider Tracker

[![CI](https://github.com/jsdylhw/rider-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/jsdylhw/rider-tracker/actions/workflows/ci.yml)

Rider Tracker 是一个本地运行的智能虚拟骑行应用，将路线规划、骑行台控制、沉浸式街景、FIT 活动管理和 AI 训练分析放在同一个界面中。

它既可以连接真实的蓝牙骑行设备进行室内骑行，也可以使用模拟功率体验路线、调试界面和回放流程。大模型、Garmin、Strava 和地图服务均为可选能力；未配置 AI 时，路线导入、骑行控制、活动记录等基础功能仍可使用。

## 主要功能

### 路线规划与路线库

- 导入本地 GPX 文件，并读取距离、海拔和坡度数据。
- 从 Strava 路线列表导入已有路线。
- 配置 Google 后，在地图上选择途经点生成路线。
- 配置大模型与地图 Provider 后，使用自然语言生成和修改 AI 路线候选。
- 保存常用路线，从起点重新骑行或继续未完成进度。
- 将当前路线导出为 GPX。

### 实时与模拟骑行

- 通过 Web Bluetooth 连接 FTMS 智能骑行台、功率计和心率带。
- 支持 ERG 固定功率、固定阻力，以及基于 GPX/Strava 海拔的路线坡度模拟。
- 支持无设备的模拟功率调试模式。
- 实时展示功率、速度、踏频、心率、坡度、距离和海拔。
- 骑行结束后生成并保存 FIT 活动文件。

### 地图与沉浸街景

- 在地图上同步展示路线和当前位置。
- 支持 Google Street View 沉浸骑行界面。
- 根据路线准备地理、历史、人文和景观讲解卡片。
- 提供海拔曲线、当前坡度和小地图等骑行信息。

### 活动与训练分析

- 导入、查看和管理本地 FIT 活动。
- 查看活动过程曲线、功率、心率、速度、爬升和训练负荷。
- 使用 Training Agent 分析单次活动或一段时间的训练趋势。
- 同步 Garmin 活动，并按需生成报告或上传到 Strava。
- 通过对话获得训练总结、恢复建议和课表建议。

### Strava 集成

- OAuth 连接个人 Strava 账号。
- 上传 Rider Tracker 生成或同步的 FIT 活动。
- 导入 Strava 中保存的路线。
- 查询路线附近的 Strava 路段，辅助路线规划。

## 快速开始

### 环境要求

- Node.js 24 或更高版本
- Python 3.12 或更高版本
- Chrome 或 Edge

实时设备连接依赖 Web Bluetooth，因此推荐使用 Chromium 系浏览器。

### Windows

直接双击：

```text
start-windows.bat
```

脚本会安装所需依赖、启动本地服务，并打开 Rider Tracker 页面。

### 命令行启动

首次使用：

```bash
npm install
npm run setup:agent
```

复制配置模板：

```bash
cp config.yaml.example config.yaml
```

启动应用：

```bash
npm start
```

浏览器会自动打开：

```text
http://localhost:8787
```

按 `Ctrl + C` 停止服务。

## 配置可选服务

所有本地配置统一填写在根目录的 `config.yaml` 中。只需要配置准备使用的功能：

- `agent`：AI 活动分析、训练建议、AI 路线和路线讲解。
- `google`：Google 路线、地点信息、Street View 和参考海拔；参考海拔不用于坡度模拟。
- `amap`：国内 AI 路线使用的高德 Web Service。
- `garmin_username` / `garmin_password`：Garmin Connect 活动同步。
- `strava`：Strava 授权、活动上传、路线和路段访问。
- `athlete`：FTP、体重以及最大/静息心率。

真实配置、OAuth Token、FIT 文件和活动数据库不会提交到 Git。
详细依赖关系见 [本地配置与功能能力矩阵](docs/feature-capability-matrix.md)。

## 基本使用流程

1. 在首页导入已有 FIT 活动，或进入实时骑行设置。
2. 按本机配置选择 GPX、Strava、AI 或地图选点路线；固定阻力和 ERG 训练也可以不选路线。
3. 连接骑行设备，或在调试模式中选择模拟功率。
4. 选择控制模式并开始骑行。
5. 骑行结束后保存 FIT，并按需上传到 Strava。

## 本地数据

Rider Tracker 默认把个人数据保存在项目的 `data/` 目录，包括：

- SQLite 活动和路线数据库
- 导入或生成的 FIT 文件
- Garmin 和 Strava 本地凭据
- Agent 会话与任务记录

这些数据默认只在本机使用。备份或迁移项目前，请同时备份 `data/` 和 `config.yaml`。

## 常用命令

```bash
npm start                 # Node 启动包装 → Python Web/Agent/Worker，默认 :8787
npm run start:legacy      # 回退旧 Node BFF → Python API 入口
npm test                  # 运行前端与 Node 测试
npm run test:agent        # 运行 Training Agent 测试
npm run test:integration  # 运行本地服务集成测试
npm run test:agent-setup  # 联网创建临时 Python 环境，验证官方安装和 FIT 上传
npm run test:all          # 运行完整测试
```

参与开发或使用编码 Agent 修改项目时，请从 [开发文档导航](docs/README.md) 和
[开发与排障指南](docs/development-guide.md) 开始；它们说明当前代码 owner、主要业务时序、测试边界和
文档权威层级。

Rider Tracker 仍在持续开发中，功能和界面可能随版本更新而调整。


### Python 统一入口

`npm start` 现在只通过 Node 启动 Python 统一后端，浏览器直接访问 Python。沿用 `rider.host/port`（默认本机 :8787）；配置和数据位置不变。Python 选择沿用 `PYTHON_EXECUTABLE` / `training_agent.python_executable`、项目 .venv、系统 Python 的优先级。需要回退时先退出当前入口，再运行 `npm run start:legacy`。

已准备好依赖的 Conda/虚拟环境也可绕过 Node，使用相同公共端口配置：

```bash
python scripts/start-rider.py --public-entry
```

此命令使用当前 Python，默认在 `http://127.0.0.1:8787/` 提供同一 Rider 页面，并管理独立 Agent 进程与 Worker；不需要 Node 启动器，不会自动安装环境。不要与占用同一端口的默认入口同时运行。迁移验收和静态发布方式见 [Python 入口清单](docs/python-browser-entry-checklist.md)，剩余工作见 [后端融合目标](docs/backend-unification-goal.md)。

可通过 `python scripts/build-rider-release.py --output dist/rider-python-preview` 导出不包含本地数据、凭据和 node_modules 的预览发布目录。安装、平台约束和回退步骤见 [发布说明](docs/python-release-runbook.md)。
