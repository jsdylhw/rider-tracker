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

## 实施记录

### 2026-08-27：阶段 0、1 收尾

阶段 0（冻结决策和基线）与阶段 1（删除 Training Agent 遗留 Web UI）的代码工作已经分别完成并
提交，后续迁移从阶段 2 开始。

阶段 0 已落地：

- 本 ADR 和唯一权威最终架构文档；
- `tests/contracts/rider-browser-http-api.v1.json` 浏览器 API surface 基线；
- API surface、跨层依赖及生产 `demo/` 依赖不再扩大的架构护栏；
- 稳定 schema 注册表以及根 CI 中的 JavaScript、Python、契约和双进程检查。

阶段 1 已落地：

- 删除 Python 静态页面、旧页面专属 API/测试和旧主视觉；
- Rider 接回 Garmin 快捷入口与已有活动报告；
- Python `/` 只返回服务元数据，遗留 `/static/app.js` 返回 404；
- 双进程检查覆盖 Rider 唯一页面、本地活动/路线接口和 Agent health proxy。

阶段 0 冻结的是迁移约束与当前契约基线，不表示 `error.v1`、job、revision 等目标契约已经全部进入
生产；这些按权威计划的后续阶段逐项实现。Garmin、Strava、地图供应商及模型服务的真实账号验收需要
网络和凭据，属于发布前人工外部集成检查，不由无副作用 CI 自动执行。

本次收尾验证结果：

- Rider JavaScript/集成测试：335/335；
- Python Training Backend：610/610；
- 双进程集成：统一 Rider 页面、本地活动/路线接口、Agent health proxy、Python 服务元数据及遗留静态页面 404 均通过；
- SQLite：`user_version=9`，统一数据库检查通过；
- Skill case 载入、Python `compileall`、路线 Demo JavaScript syntax 和 `git diff --check` 均通过。

### 2026-08-27：阶段 2 路线业务契约收敛

路线计划的业务 owner 保持为 Python。Python 持久化完整 `route_plan.v1`，并向 Rider 投影有界的
`route_plan_view.v1`：它包含稳定的 plan/candidate/segment ID、revision、WGS84 geometry、途经点、
多日阶段、选中/确认状态和 Strava 路段目录。`presentation.v1` 继续用于通用 Agent 结果展示，但不再
承担候选识别、路线几何拼装或确认状态传递。

路线修改命令必须携带唯一 `request_id` 和当前 `expected_revision`。Python 在 SQLite 写事务内执行
compare-and-swap；重复请求返回缓存结果，过期 revision 返回 HTTP 409。Rider 只接受仍属于当前页面
操作、骑行尚未开始且 revision 前进的响应；最终确认还必须明确返回相同 candidate ID。

Rider 的地图选点路线和 Agent 路线统一通过 provider-neutral `buildCoordinateRoute` 转为实时骑行
runtime route。Provider 原始耗时仅作为数据保留；无海拔 ERG 路线的前端预计时间仍按虚拟骑行速度
计算。至此 Python 不再把路线交给 Node 重建第二份业务模型，Node 仅验证并转发 HTTP。

阶段 2 收尾时进一步关闭了分阶段路线的隐式降级：`route_plan_view.v1` 可以保留多日和 stage 数据，
但当前 Rider runtime 只接收 `single_day`，遇到 multi-day 或带 stages 的候选会明确拒绝，不再把各阶段
坐标静默首尾拼接成一条可骑路线。这样可以避免阶段间存在接驳空洞时仍被误判为有效道路路线。

阶段 2 的回归覆盖包括：同轮多个 route execution 选择最后一次业务结果、同会话多个 plan 的显式定向
修改、request ID 相同但 payload 不同的冲突重放、SQLite compare-and-swap 并发写入、浏览器晚到响应
失效，以及骑行开始后的二次丢弃检查。2026-08-27 验收结果为 Rider `343/343`、Training Agent
`622/622`；最终架构文档保持为冻结决策，本段只记录实现和验收状态。
