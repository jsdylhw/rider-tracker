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

### 2026-08-27：阶段 3 可选 AI 与降级运行

阶段 3 将“Python 业务后端是否运行”和“是否配置大模型”拆成两个独立状态。大模型不再是 Rider
启动和基础骑行的前置条件；统一配置新增 `agent.enabled`，`auto` 只在 `base_url`、`api_key`、`model`
均已配置时开放 AI，`false` 则显式关闭所有 LLM 调用。该开关不会关闭 FIT 确定性处理、活动详情、
运动员档案和 Strava 等 Python 后端能力。

Python `/health` 现在投影 `training_backend_capabilities.v1`，分别报告 `backend`、`llm` 以及
`fit_ingestion`、`activity_detail`、`athlete_profile`、`strava`、`activity_analysis`、
`training_history`、`ai_route_planning`、`route_narration`。这是配置就绪度，不会在 health 请求中
访问外部模型。聊天与路线讲解在 LLM 未配置或被关闭时返回结构化 HTTP 503：
`code=agent_unavailable`、具体 `capability`、`retryable` 和可读原因；Node BFF 统一保留该错误语义，
但不会把 Strava 等上游服务自身的 HTTP 503 误判为后端掉线。

`npm start` 不再等待 Training Backend 健康后才启动 Rider。组合模式中 Rider 是关键进程，Python
启动失败或运行中退出只记录告警，不会结束 Rider；`npm run start:agent` 仍保持 fail-fast，便于独立
诊断。Rider 就绪后默认只打开产品入口 `http://localhost:8787`；Python sidecar 继续绑定本地地址，
其 Uvicorn 启动信息和 access log 不作为产品输出。无桌面环境或 `rider.open_browser=false` 时只打印
Rider 访问地址。浏览器每 15 秒刷新一次 capability，连接恢复后自动恢复 AI 入口。无 LLM 时首页对话、AI
路线生成和街景讲解显示明确原因并禁用请求入口，但 GPX、地图选点、路线库、设备连接、ERG、街景
和实时骑行不被锁定。

本阶段增加无 AI 单元测试和 `npm run test:degraded` 进程级验收。后者使用已迁移的临时数据库，依次
模拟 Python 无法启动、后端恢复、再次掉线，确认 Rider 页面、本地活动 API 和路线库始终可用，
Agent health 在三秒交互预算内返回标准 503，并能在恢复后重新报告 capability。2026-08-27 验收结果：

- Rider JavaScript：`353/353`；
- Python Training Backend：`627/627`；
- 正常双进程集成：通过；
- Agent 降级、恢复及再次掉线集成：通过；
- Python `compileall` 与 `git diff --check`：通过。

阶段 3 不等于删除 Python Backend，也不允许绕过统一数据库 migration。它解决的是可选 LLM 或
Agent 进程故障不应扩大为整套 Rider 不可用；Python 最终接管全部后端和静态页面仍按后续阶段推进。

### 2026-08-27：阶段 4 运行时路径与数据库 schema owner 收敛

阶段 4 新增 Python `RuntimePaths` 作为可变本地数据的唯一路径契约。数据库、FIT、凭据、Workflow、
journal、日志、缓存、评测产物和迁移清单默认统一位于项目根 `data/`，并允许通过统一配置或环境变量
覆盖；相对路径始终相对项目根解析，不再依赖 Node、Python 或 CLI 启动时的当前工作目录。Node 启动器
负责把同一组解析后的路径传给 sidecar，数据库变量发生分叉时 Python 会拒绝启动，而不是静默选择其中
一份。旧 FIT 目录只保留只读查找兼容，新下载和导入不再写入旧位置。

用户数据迁移保持显式、copy-first。`npm run data:audit` 只生成计划，不写文件；
`npm run data:migrate` 在不存在冲突时复制并校验内容、保留源文件、限制凭据文件权限，并写入一次性
manifest。旧 SQLite 文件永不自动合并。本机只读审计发现 2 个目标冲突和 3 个需人工确认的旧数据库，
因此本阶段没有执行真实迁移，也没有修改这些用户数据。

SQLite schema 的唯一 owner 已收敛到 Python migration。Node 的 activity/route store 删除了
`CREATE TABLE`、`ALTER TABLE` 和独立 schema 分支，只检查 `user_version`、必需表和列；数据库缺失或
版本不匹配时给出显式 `db:init`/`db:migrate` 指引，且不会自行创建文件。Node 单元测试使用 Python
迁移器生成临时数据库，架构测试阻止服务端重新引入 DDL。

本阶段解决的是“同一数据因 cwd、进程或旧默认值落到不同目录”和“Node/Python 各自演进 SQLite”两类
结构性问题。默认物理目录仍是开发期布局；后续移动 Python 源码时只需调整 resolver/打包入口，不需要
再次修改各业务模块或迁移一遍数据。

阶段 4 验收结果：

- Rider JavaScript：`356/356`；
- Python Training Backend：`639/639`；
- 正常双进程集成和 Agent 启动失败、恢复、再次掉线的降级集成均通过；
- 真实统一数据库只读检查通过：`user_version=9`；
- `data:audit` 保持只读，结果为 53 个待复制文件、2 个冲突和 3 个旧数据库人工确认项；
- `compileall`、`git diff --check` 和 Node 生产目录 DDL 扫描通过。

验收期间还发现并修复了两个边界问题：正常集成测试在 Node DDL 删除后必须显式调用 Python migration
创建临时数据库；Tool Loop 测试日志必须写入各自的 `tmp_path`，不能污染用户 `data/logs`。本轮误写的
9 个明确测试日志已清理，其他用户数据未修改。

阶段 4 复审又关闭了四个遗漏边界：无环境变量时项目根改为从嵌入后端代码位置确定，不再回退
`cwd`；配置、旧运动员档案和外部集成默认路径改为调用时解析；FIT ingest 的允许目录改为实际
`RuntimePaths.fit_root`；Node 数据库 guard 对 `user_version` 做精确匹配，并由架构测试约束其版本与
Python migration 常量一致。独立探针确认从 `/tmp` 启动仍解析到 Rider 根目录，且手工降为 schema 8
的数据库会被 Node 拒绝。Python 测试统一使用临时 runtime root，防止之后的 cwd 回归污染真实数据。

### 2026-08-28：阶段 5A 路线库与续骑进度切换到 Python owner

阶段 5 的第一个纵向切片迁移 `saved_routes` 和 `route_progress`。Python 新增 `SavedRouteStore`，统一
负责路线来源别名、坐标清洗、geometry fingerprint 去重、路线 JSON、Agent plan/candidate 关联、元数据
合并以及续骑进度的保存和完成清理。FastAPI 在内部端口实现与浏览器既有 URL 对应的路线 CRUD 和进度
API；Node 保留相同的 `/api/routes*` 公开协议和同源安全，只做异步转发，不再打开 SQLite 或执行业务
规则。原 `src/server/route-library-store.js` 及其 Node 仓储测试已经删除，等价行为改由 Python repository、
FastAPI API 和双进程 CRUD 回归覆盖。

这个切片没有迁移 `activities`，因此 `src/server/activity-store.js` 暂时仍是生产 Node SQLite 使用者；
也没有提前实现“确认 Agent 候选并原子保存 SavedRoute”，该事务属于阶段 5 的下一切片。浏览器路线库
协议没有变化，前端适配器无需改写。

路线库属于 Python 业务后端能力，而不是 LLM 能力：Python 正常运行但未配置模型时，路线保存、加载和
进度仍可用；Python 进程不可用时，不再提供 Node SQLite 回退，而是在 2 秒内返回
`agent_unavailable / route_library`。Rider 页面、设备、ERG/坡度模式、运行时路线以及当前尚未迁移的
活动列表继续可用。此行为替代阶段 3 中“Python 掉线时路线库始终可用”的迁移期假设，避免重新形成双
owner。

复审期间进一步关闭了四个迁移边界：`save_route` 的读取、元数据合并和 upsert 现在由
`BEGIN IMMEDIATE` 串行化，避免并发重复 geometry 返回不存在的临时 UUID 或丢失元数据；路线重命名
同时更新目录字段和 `route_json.name`，同 geometry 的距离修正会清除已越过新终点的续骑进度；路线
语义校验继续映射为旧公开协议的 HTTP 400，而不是泄漏 FastAPI 422；Node 代理路由增加不依赖本地
监听端口的操作映射、错误透传和降级单测。

阶段 5A 验收结果：

- Rider JavaScript：`357/357`；
- Python Training Backend：`648/648`，其中新增路线仓储和 API 等价测试；
- 正常双进程集成覆盖路线创建、重命名、续骑、详情和删除：通过；
- Python 启动失败、恢复和再次掉线的降级集成：通过；
- 生产 Node 中路线仓储及其 `node:sqlite` 引用已删除，`git diff --check` 通过。

### 2026-08-29：阶段 5B Agent 路线确认与保存原子化

阶段 5B 消除了 Agent 路线确认中的最后一个双写窗口。此前浏览器先调用 Python 确认候选，再单独调用
路线库接口保存 runtime route；第二次请求失败时，路线计划已经进入 confirmed，但路线库中没有对应路线。
现在 Rider 在确认请求中携带它根据候选生成的 runtime route 快照，Python 在同一个 SQLite 连接和
`BEGIN IMMEDIATE` 事务中完成候选校验、路线计划 revision compare-and-swap、确认状态更新以及
SavedRoute upsert。任一步失败都会同时回滚两项写入，浏览器也不再允许“确认成功但保存失败时仍可骑行”
的降级状态。

Python 会验证 chat workspace、plan/candidate ID、单日路线类型、候选名称、来源和距离容差。Google、
高德或 Strava 返回并进入 RoutePlan 的 provider 路线是几何事实来源；浏览器从该候选构建 runtime route，
Python 不再用另一套坐标清理规则逐点复核 provider 几何。SavedRoute repository 仍负责坐标、距离和来源
的基本结构校验。Python 在 plan revision 写入后覆盖 SavedRoute 内外层 Agent metadata，确保状态为
confirmed、revision 为本次事务的新值。Node BFF 仅校验并完整转发 `saved_route` 请求字段；Rider
只有在响应同时返回递增 revision、相同 confirmed candidate 和 SavedRoute ID 时才提交可骑 runtime
route。重复 `request_id` 继续返回会话缓存结果，过期 revision 继续返回 HTTP 409。

本切片增加了事务中第二次写入失败的强制回滚测试、非法距离不改变 plan revision 的测试、权威
confirmed metadata 测试、重复请求幂等测试、浏览器确认请求及 Node BFF 字段转发测试。
双进程集成会经 Rider 公开 BFF 发起一次真实确认，再分别读取 plan 和 SavedRoute 验证同一事务结果。
验收结果：

- Rider JavaScript：`359/359`；
- Python Training Backend：`651/651`；
- 正常双进程集成（含 Agent 路线原子确认）：通过；
- Python 启动失败、恢复和再次掉线的降级集成：通过；
- Python `compileall` 与 `git diff --check`：通过。
