# ADR 0001：Rider 业务后端统一到 Python

- 状态：已接受
- 日期：2026-08-26

具体目录、阶段编号、执行顺序和完成标准统一见
[`../rider-final-architecture-and-python-migration.md`](../rider-final-architecture-and-python-migration.md)；
本 ADR 只固定不可轻易改变的架构决策。

## 背景

Rider Tracker 当前同时运行 Node/Express 与 Python/FastAPI。浏览器通过 Node 同源 API 访问页面，
Node 和 Python 又共同访问活动、路线、SQLite、FIT 与 Strava 能力。`services/training-agent` 名义上是
Agent，实际已经包含 FIT、训练分析、路线规划、Provider、Workflow、数据库和 HTTP API。

这造成三个长期问题：同一后台能力存在两个 owner；Python 正式代码被困在一个误导性的 Agent
目录中；本地部署必须协调两个服务端进程和两套运行时路径。

## 决策

Rider Tracker 采用以下最终运行边界：

```text
Browser JavaScript
  - UI、地图展示、Web Bluetooth、FTMS
  - 实时骑行状态、物理计算和 runtime route
          |
          | 同源 HTTP / WebSocket
          v
Python Backend
  - FastAPI 与正式 Rider 静态页面
  - Activity、Route、Athlete 与 Workflow application use case
  - SQLite migration、repository 和事务
  - FIT、Garmin、Strava、地图 Provider 与 LLM
  - Training Agent、Skill、Tool adapter 和 Presentation
```

Python 正式源码逐步迁入根 `src/`，按职责进入 `api/`、`application/`、`domain/`、
`infrastructure/`、`agent/` 和 `cli/`。JavaScript 继续保留在根 `src/` 中的浏览器应用、领域运行时
和适配器；跨语言重名领域必须使用明确子目录，例如 `domain/route/runtime` 与
`domain/route/planning`。

Node/Express 是迁移期 BFF，不是最终业务 owner。迁移期间它保持浏览器 URL、同源安全和 OAuth
回调，并逐个将 API 转发到 Python。所有数据库读写迁走后，由 FastAPI 接管 `:8787`、正式 Rider
页面和 `/api/*`，Node 退出生产运行时，但继续用于前端依赖、测试和可选构建。

普通本地使用仍保持一个入口：

```bash
npm start
```

最终该命令只负责定位打包或本地 Python、检查配置并启动统一 Backend。桌面发布可使用
Electron 管理打包后的 Python sidecar；用户不需要安装 Conda 或手动启动第二个端口。

## 不做的事情

- 不把浏览器 UI、Web Bluetooth、FTMS 和实时骑行代码重写为 Python。
- 不把已有 FIT、路线、Agent 和 Provider 全量重写为 JavaScript。
- 不在一个提交中同时移动源码、修改公开 API、升级数据库和迁移用户数据。
- 不恢复 Python 的第二套产品 Web UI；FastAPI 最终托管的是唯一 Rider 页面。
- 不让 Agent Tool 直接成为数据库、文件或 Provider owner；Tool 只适配 application use case。

## 迁移约束

1. 浏览器现有 `/api/*` URL 在迁移期间保持不变。
2. `agent_turn.v1`、`presentation.v1`、`activity_detail.v1` 和 `route_plan.v1` 保持兼容。
3. Python migration 是唯一 schema owner；数据库 owner 的切换按纵向 API 切片完成。
4. 用户数据库、Token、FIT 和 Workflow 只允许显式审计、备份和迁移。
5. 生产 Python 不得新增对 `demo/` 或 `experiments/` 的依赖。
6. 每个迁移提交必须保持可启动、可回归并可独立回滚。

## 后果

正面结果是业务后端、持久化和运行时路径最终只有一个 owner，本地服务可收敛为单进程，也便于
打包桌面应用。代价是迁移期仍需维护 Node 到 Python 的兼容代理，且根 `src` 会同时包含 JavaScript
和 Python；因此必须依靠职责目录、架构测试和跨语言 contract，而不是仅凭文件扩展名维持边界。
