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

### 2026-08-29：阶段 5C 首页活动目录切换到 Python owner

阶段 5C 将首页活动列表、单条详情目录、重命名和删除四项能力从 Node SQLite store 切换到 Python
`ActivityStore`。浏览器继续使用原有 `/api/activities*` 公开 URL；Node BFF 只负责同源保护、参数映射、
错误透传，以及把 Python 的确定性活动详情适配为现有 Rider 展示结构，不再自行查询或修改这部分活动
业务数据。分页、运动类型和来源过滤由 Python 执行；列表页汇总继续保持原有语义，统计整个活动库而
不是当前过滤页。

删除活动时，数据库记录及其关联 facts、series、artifacts、reports 由 SQLite 外键级联清理。只有位于
统一 `RuntimePaths.fit_root` 内的受管 FIT 文件才随活动删除；索引到外部位置的 FIT 文件不会被删除。
重命名只修改活动目录名称，不改写原始 FIT 或外部服务中的活动名称。

活动目录和路线库一样属于 Python 业务后端能力，而不是 LLM 能力。Python 正常运行但没有模型配置时，
活动浏览、详情、重命名和删除仍可用；Python 进程不可用时，Node 在两秒预算内返回结构化
`agent_unavailable / activity_library`，不回退到旧 Node 查询路径。该行为替代阶段 3 和阶段 5A 中
“后端掉线时活动列表继续可用”的迁移期假设，避免同一张活动表再次形成双 owner。

本切片刻意没有迁移实时骑行 session 归档、FIT 上传/导入写入以及活动与路线关联写入，因此
`src/server/activity-store.js` 仍暂时存在并服务这些后续切片；阶段 5 尚未整体完成。新增回归覆盖 Python
仓储的分页/过滤/汇总和级联删除、FastAPI CRUD 与受管/外部 FIT 删除边界、Node 代理协议、标准降级，
以及经 Rider 公开 BFF 完成列表、详情、重命名和删除的双进程往返。验收结果：

收尾时同步删除 Node store 中已经失去生产调用的列表、分页、详情、汇总、重命名和删除实现及其旧仓储
测试。Node store 目前只保留后续 5D/5E 仍在使用的 session 写入、单条内部读取、FIT metadata 更新和
活动路线关联，不再保留已经由 Python 接管的备用读写路径。

代码复审进一步关闭了三个边界：活动重命名和删除使用短于 Node 两秒代理预算的 SQLite 写锁等待，锁
竞争会在一秒左右以可重试 503 失败，且不会在浏览器超时后迟到提交或删除 FIT；重命名重新严格要求
字符串，不再把数字、布尔值或对象强制转换成名称；FIT 活动详情的目录读取与确定性详情读取共享同一
个两秒总预算，第一段请求消耗的时间会从第二段扣除，不再出现目录已返回但详情仍等待四分钟的情况。
对应回归覆盖了真实 SQLite 写锁、失败后数据不变、非字符串 HTTP 400 和详情预算耗尽时不发起第二次
请求。

- Rider JavaScript：`364/364`；
- Python Training Backend：`658/658`；
- 正常双进程活动目录 CRUD 集成：通过；
- Python 启动失败、恢复和再次掉线的降级集成：通过；
- Python `compileall` 与 `git diff --check`：通过。

### 2026-08-31：阶段 5D Rider session 归档切换到 Python owner

阶段 5D 将无 FIT 的 Rider session 兜底归档从 Node SQLite store 迁移到 Python。浏览器继续调用既有
`POST /api/activities/rider-session`；Node BFF 只转发 session、名称和运动类型，并在两秒预算内返回
Python 结果。FIT 编码、文件写入和解析的正常主链路没有改变，本切片也没有引入离线队列或复杂归档状态机。

Python 新增确定性的 session normalization 和专用 repository 写入。活动 ID、名称优先级、运动类型、
摘要指标和 GPS 判断保持旧 Rider 语义；活动 upsert、`saved_route_id` 及路线起止距离在同一个
`BEGIN IMMEDIATE` 事务中提交。重复 session 使用稳定 ID 覆盖同一活动，且不会清除稍早写入的 FIT
metadata、facts 或报告。`fit-beacon` 中先保存 session 的步骤也改用同一 Python API，但 FIT 文件接收、
metadata 更新、ingestion 及 FIT 路径上的路线补写仍留给阶段 5E。

Node `activity-store.js` 删除 session normalization、稳定 ID 和 `saveRiderSession` SQL，仅保留阶段 5E
仍使用的单条内部读取、FIT metadata 更新和活动路线关联。Python 不可用时，Node 返回结构化
`agent_unavailable / activity_archive`，不回退到 Node SQLite。

代码复审进一步收紧了三个边界：缺少 `route` 的重复归档保留既有路线关联，避免精简或重试请求清空
`saved_route_id` 和距离窗口；归档结果在同一个受一秒写锁预算约束的 SQLite 连接中读回，避免写入已提交后
第二次读取超出 Node 两秒代理预算；Node 同时完整透传 Python 的 `activity_store_busy` 和 `retryable`，供前端
明确提示重试。

验收结果：

- Rider JavaScript：`371/371`；
- Python Training Backend：`664/664`；
- session normalization、重复归档、既有 FIT/report 保留和 FastAPI 协议定向测试：`33/33`；
- 正常双进程经 Rider 公开 URL 验证 session 与路线距离窗口一次归档：通过；
- Python 启动失败和再次掉线时 session archive 结构化降级：通过；
- `git diff --check`：通过。

### 2026-09-03：阶段 5E FIT ingestion 与活动路线关联切换到 Python owner

阶段 5E 删除了生产 Node 对活动 SQLite 的最后一组直接读写。浏览器仍通过 Rider 的 multipart 接口上传
FIT，Node 暂时继续把文件写入统一 `FIT_FILE_DIR`，随后只把受管相对路径和活动上下文转发给 Python。
让 Python 直接接收 multipart 和托管文件属于阶段 7 的边缘 Web API 迁移，不在本切片提前实施。

Python 现在先在事务外完成 FIT 解析、指标与展示 artifact 构建，再通过一个短 `BEGIN IMMEDIATE` 事务
原子写入活动目录、FIT 文件 metadata、确定性 facts、`activity_detail` artifact 和可选的 SavedRoute 距离
窗口。显式传入路线关联时由该事务更新；省略时保留 Rider session 兜底归档已经写入的路线信息。相同
FIT 重试维持稳定 activity ID 和 facts revision，也不会清除既有报告、raw session 或路线关联。
`fit_ingestion.v1.activity` 继续返回既有的 `facts_schema_version` 与 `facts_revision`，避免事务重构缩减
已发布响应契约。

三条公开路径保持不变：新 FIT 导入、给既有活动补 FIT、页面关闭时的 `fit-beacon`。其中既有活动查询也
改为调用 Python 活动目录，不再从 Node SQLite 读取。Python 的 404、`activity_store_busy` 和
`retryable` 元数据由 Node BFF 原样透传；后端不可用时继续返回能力级 `fit_ingestion` 降级，不恢复 Node
数据库 fallback。

收尾删除 `src/server/activity-store.js` 及其旧仓储测试，并增加架构回归，禁止生产 `src/server` 重新
引入 `node:sqlite`。数据库 preflight 脚本仍可只读检查 Python 管理的 schema；它不承担业务读写，因此
不属于生产持久化 owner。

本切片没有处理 `activity_detail.v1` 重复保存 metrics，也没有实现路线库完整骑行生命周期；两项继续
由已知问题文档跟踪。运动员档案的旧 `user-profile.json` 启动兼容仍留给阶段 5F。

验收结果：

- Rider JavaScript：`376/376`；
- Python Training Backend：`675/675`；
- FIT ingestion、事务回滚、锁超时、幂等路线保留和 FastAPI 协议定向测试：通过；
- 正常双进程经 Rider 公开 URL 验证 session 归档、真实 FIT 编码/上传/解析及路线窗口保留：通过；
- Python 后端启动失败、恢复和再次掉线的结构化降级集成：通过；
- Python `compileall`、生产 Node 无 `node:sqlite` 架构检查及 `git diff --check`：通过。

### 2026-09-04：阶段 5F 运动员档案兼容与数据库启动职责收口

阶段 5F 移除了 Node 对旧 `user-profile.json` 的读取和启动期导入。Rider 的公开
`/api/user-profile` 协议保持不变，但 Node 现在只代理 Python 的 athlete profile API。统一数据库没有
运动员档案时，Python 按统一配置、旧 Agent 档案的既有规则迁移；仅当前两者均为空时，才兼容读取
Rider 根目录的旧 `user-profile.json`。成功写入 `athlete_profiles` 后，后续读取只认数据库，旧文件不会
覆盖用户的新设置。兼容文件暂不自动删除，避免迁移失败或用户回退版本时丢失数据。

启动预检也完成单 owner 收口。Node 不再通过 `node:sqlite` 打开数据库，不再复制 schema version、必需
表清单或字段规则；完整启动器只执行 Python `database-tool.py ensure`。该命令每次启动都会做轻量 schema
检查，但仅在数据库不存在或版本不匹配时执行初始化或备份迁移，正常启动不会反复迁移。Python 解释器
完全不可用时，Rider 核心仍可独立启动，数据库能力按既有协议明确降级；单独启动 Rider BFF 时不执行
无意义的数据库预检。Python 存在但 schema 检查或迁移失败时，完整启动仍会阻止服务进入不一致状态。原 Node
`managed-database.js` 已删除，架构测试同时覆盖生产 server 和启动预检脚本，防止 SQLite 判断重新进入
Node。

至此阶段 5 的数据库所有权迁移完成：路线、活动目录、session 归档、FIT ingestion、活动路线关联、
运动员档案和 schema 生命周期均由 Python 持有；Node 只保留浏览器公开协议、同源校验、multipart 文件
接收和 Python API 转发。`activity_detail.v1` 的重复 metrics 与完整路线骑行生命周期仍是独立业务债，不
影响本阶段的单 owner 验收。

### 2026-09-04：阶段 6A 路线 Provider 正式化

阶段 6A 将生产路线规划实际使用的高德骑行、WGS-84/GCJ-02 转换、Google Routes 和 Strava Segment
实现从 `demo/` 提升到正式 `integrations/route_providers/`。纯球面距离计算不属于外部 Provider，移入
`services/route/geometry.py`。`popular_loop`、`single_day`、`segment_aware` 和 `segments` 均改为只依赖
正式层，生产 Python 对 `demo` 的导入基线由 15 条收紧为 0，架构测试禁止以后重新引入。

原先路线规划和路线讲解各自维护一套 Google Places 客户端。本切片将两类查询统一到
`integrations/google_places.py`，共享密钥校验、传输、重试和错误处理，同时保留不同的稳定返回形态和
字段掩码：路线锚点只请求地点、坐标和国家等必要字段，讲解代表点才请求简介、地图链接和照片元数据。
因此收敛实现不会让普通路线规划承担讲解资料的响应体和延迟。

三个历史路线 Demo 连同算法、调试 Web、CLI、fixture 和 Docker 资产原样迁到仓库根目录
`demos/training-agent-route/demo/`。阶段 6A 曾将其中四个 Provider 文件改成正式实现的兼容包装器；收尾时
恢复了迁移前的独立实现，使 Demo 和正式服务双向都没有源码依赖。这里保留的重复代码是实验快照与生产
实现的明确分界，不要求同步演进。正式 Provider 的契约测试迁入 `services/training-agent/tests/`，Demo
测试则从新目录独立运行；架构测试同时禁止 `demo`/`demos` 重新进入生产依赖，并要求服务包内不再存在
`demo/`。

代码复审同时收紧路线讲解来源边界：允许模型生成完全不声明来源的区域背景卡片，但只要显式提交
`source_ids`，所有 ID 都必须来自本轮受信资料，任何未知引用都会让整张卡片被丢弃并产生 warning，不能
通过过滤 ID 把伪造引用静默转换成无来源内容。本切片不改变公开 HTTP、路线 schema、数据库、候选选择
或前端行为，也不提前引入长任务 Job；阶段 6B 将在独立的正式 Provider 边界上实现持久化 Job、Worker
和轮询/取消协议。

### 2026-09-05：阶段 6B-1 持久化任务基础设施

新增 `job.v1` 公开快照、Python `JobStore` 和独立 `worker.main` 入口。SQLite schema 从 9 升至 10，
新增 `jobs` 与 `job_workers`；沿用统一启动器的备份、ensure 和只在版本变化时迁移机制。Worker 只消费
已准备好的数据库，不自行初始化 schema。Node 仍只负责同源保护和短超时代理。

新增浏览器与 Python 同路径接口：

- `POST /api/jobs`：校验已注册任务类型及其输入，持久化后返回 202；
- `GET /api/jobs/{job_id}`：读取持久化快照；
- `POST /api/jobs/{job_id}/cancel`：请求取消，已结束任务保持原终态；
- `GET /api/jobs/capabilities`：Worker 存活、Worker 支持类型及 API 注册类型。

当前生产注册表为空，测试处理器仅放在 tests 中，由测试组合入口显式注入。该阶段不改变报告、Agent、
路线规划和同步的执行行为，不开放任意 Python 导入、命令执行或测试任务。下一切片将注册批量活动报告
重建类型及 Worker handler，并替换旧内存队列。

任务状态为 `queued/running/succeeded/failed/cancelled`。运行中取消先记录 `cancel_requested`，处理器
在 checkpoint 停止后才进入 cancelled；排队任务可立即取消。完成与取消通过同一短写事务决定结果。
进度只公开阶段与完成数量，不估造百分比。输入、租约凭证、内部路径和原始异常不包含在公开快照内；
业务处理器返回的 result_ref 必须是受控资源标识，不能直接返回模型结果或 provider 响应。

本地单用户使用固定 `local` 提交作用域。同作用域与 request ID 的重复提交返回同一任务，包括已经结束
的任务；不同类型或不同规范化输入使用相同 ID 返回 409。用户明确重新执行应生成新 request ID。

Worker 单执行槽，使用 `BEGIN IMMEDIATE` 短事务原子领取。生产默认租约 30 秒，独立心跳线程每 5 秒
续租，空闲每 0.5 秒检查队列。所有进度和终态写回校验领取凭证与租约有效期。任务执行和外部 I/O 不在
数据库事务中。Worker 存活信息超过 15 秒未更新即判定不可用，过期记录在后续心跳中清理。

重启恢复采用明确的类型策略：默认 `fail`，租约过期后标记 `worker_interrupted`，不盲目重做外部副作用；
只有声明可安全重试的类型才使用 `retry`，并有尝试上限。取消中的过期任务进入 cancelled。恢复由存活的
Worker 扫描触发，API 重启只恢复查询，不执行任务。正常 Worker 停止会等待当前处理器返回；强制结束
后依赖租约恢复。

该机制保证提交幂等和任务状态写入隔离，不承诺外部调用 exactly-once。后续报告 handler 必须提供业务
检查点、幂等落库，并将领取凭证校验扩展到业务结果提交事务；不能仅靠任务 finish 的校验防止旧执行
覆盖活动报告。现有 Workflow 的步骤依赖与外部上传恢复语义继续由 Workflow 管理，Job 只负责调度。

验收覆盖临时 schema 9 数据库的升级及备份、并发领取、过期写回拒绝、取消与完成竞态、错误脱敏，以及
真实 Node -> Python API -> 独立 Worker 的提交、API 重启、Worker 强制退出、恢复与取消链路。测试使用
临时数据和确定性处理器，不调用模型或外部账号，也不升级开发者现有数据库。

回退时先停止 API 与 Worker，保存当前数据副本，再恢复本次 migration 生成的 schema 9 备份并使用前一
版本代码。备份之后新增的数据不会自动合并，不能直接用旧备份覆盖仍需保留的新活动。仅回退代码不足以
降低 schema 版本；不提供在线自动降级。数据库 migration 与业务任务迁移保持独立验收。

本机 Windows 全量回归还发现四项既有失败：活动 ingestion 的旧路径身份复用、`test_relpath` 的路径
分隔符，以及两个 Strava Token 测试对 POSIX `0600` 的断言。已在未修改的 `a47e3c2` 导出副本中复现，
不作为本次 Worker 的回归引入。正常双进程集成另修复了 Windows 清理竞态：等待子进程退出后再删除
临时目录。统一启动器支持父 Node 进程 IPC 断开时清理自己启动的服务，避免测试或监督进程结束后遗留子进程。

### 2026-09-05：Windows / Linux 路径与权限测试兼容

修复上述四项 Windows 失败。项目内的持久化 FIT 路径统一使用 `/`，相对路径始终从项目根解析；读取
同时兼容旧 Windows `\` 及混合分隔符。活动身份查找、按 FIT 查询和写入去重共用路径别名，保留已有
活动 ID、名称、报告与路线关联。外部文件仍使用绝对路径，并统一序列化分隔符；不猜测 Windows 盘符
和 WSL 挂载点之间的映射，不批量改写用户数据库，记录在正常写入时更新为规范形式。

Strava Token 的刷新、原子替换和旧格式兼容行为保持不变。POSIX 平台继续验证 `0600`；Windows 的
`chmod` 只控制只读属性，测试验证可读写属性及完整保存/重载行为，不能从 `st_mode` 推断 Windows ACL。
Windows 访问权限仍由所在目录的 ACL 管理，本切片没有新增或修改 ACL。此平台差异见
[Python os.chmod 文档](https://docs.python.org/3/library/os.html#os.chmod)。

增加反斜杠历史记录、混合分隔符、中文文件名、切换工作目录、目录外绝对路径及旧身份复用回归；CI 同时
运行 Ubuntu 和 Windows。外部 FIT 和 session 归档测试同步断言规范路径，避免依赖运行系统的默认分隔符。

本次实测 Windows（Python 3.13）与 WSL Ubuntu（隔离 Python 3.14 环境）均通过 Python 648/648、
JavaScript 394/394 及正常 Node/Python 集成，两边使用 Node 24.14.1。WSL 依赖位于独立临时环境，
未更改系统 Python 或用户业务数据。WSL 在共享源码目录写入 Windows 创建的 pytest 缓存时有权限 warning，
不影响测试结果；可用 `pytest -o cache_dir=/var/tmp/rider-pytest-cache` 指定 Linux 侧缓存位置。

### 2026-09-05：阶段 6B-2 批量报告迁入持久化 Worker

生产注册 `activity_report_rebuild.v1`，替换 `report_batch` 的内存字典和线程池。Agent 的报告重建工具、
调试 CLI 和通用 Job API 共用提交服务；提交事务只校验输入并保存任务，不解析 FIT 或调用模型。
现有 Agent 对话、单次分析、路线规划及 Garmin/Strava 工作流继续使用原执行入口。

SQLite schema 从 10 升至 11，新增 `report_job_items`。每次提交固定活动 ID、FIT 路径、报告及事实版本，
支持 `all/outdated` 和显式活动子集，最多 1000 项；不存在或没有 FIT 路径的显式 ID 被拒绝。
任务与清单在同一事务创建，重复 request_id 直接复用原任务，不重新扫描活动目录。报告内容不放入任务表。
API 对话工具从受信会话与 request_id 派生提交 ID，避免请求在 API 重启后重放时重复建任务。

Worker 单项分析使用目录中的稳定活动 ID，以只读模式生成报告。FIT 内容摘要在该项首次执行时固定，
执行前后校验文件内容；写回事务再次检查活动路径、报告及事实版本、有效领取凭证与取消标记。
报告、目录补充信息、首次生成的事实以及成功检查点原子提交，避免出现“报告已保存但进度未记住”。
已删除或已更新的活动返回 `input_changed`，旧 Worker 或过期租约不能覆盖报告。

恢复策略为 retry，最多领取 3 次；恢复时只处理 pending 项。已经提交成功的活动不会再次调用模型。
中断时仍在进行的模型调用可能在重试时重复，不能保证外部模型调用恰好一次。排队取消立即生效；运行中
取消等待当前模型请求返回后停止，并丢弃尚未保存的结果。已提交的报告保留。模型未配置时逐项返回
`ai_unavailable`，不发起模型请求；Worker 未启动时任务保持 queued 并明确返回不可用状态。

`job.v1` 继续使用通用 succeeded/failed 状态，报告详情接口 `GET /api/jobs/{job_id}/report-rebuild`
提供 completed/partial/failed 和逐项状态。某项失败不阻止后续项；重新执行失败子集需新 request_id。
公开错误仅包含受控代码，不返回 FIT 路径、凭证或模型原文。Agent 新增取消工具，CLI 默认提交后返回，
`--wait` 可有界等待，`report-job <job_id> [--cancel]` 可查询或取消。

验证覆盖提交重放、快照清单、部分失败及定向重试、原子回滚、旧租约拒绝、模型执行期间取消、文件和
报告更新冲突、稳定活动 ID、模型不可用、CLI，以及临时 schema 10 数据库的备份升级和既有任务/报告保留。
真实 Node -> API -> Worker 进程测试在保存第一份报告后强制结束 Worker、重启 API 与 Worker，确认
检查点恢复、已保存报告未重复分析、取消时报告未被覆盖。所有测试使用临时数据库与模型替身。

本切片最终实测 Windows Python 3.13 与 WSL Ubuntu Python 3.14 均通过 Python 665/665、
JavaScript 394/394，以及正常、降级集成测试；WSL 的 2 条第三方依赖弃用提示不影响结果。

回退需先停止 API 和 Worker，保存当前数据副本，再配合 schema 10 备份恢复对应代码；升级之后新增的
报告和任务需另行保留，不能直接覆盖。数据库升级沿用统一启动器的 ensure 和备份机制。

### 2026-09-05：阶段 6B-3 报告任务前端接入

复用首页 Agent 的 presentation 工作区，新增 `report_job` 展示标识及浏览器任务跟踪服务。首次收到任务
自动展开卡片，通过已有 Job HTTP 接口读取真实进度、请求取消及按失败活动新建重试。报告详情补充活动
名称用于解释失败项，不增加数据库字段或新 HTTP 路径。街景讲解卡片保持原实现。

本地保存任务 ID 和失败重试的请求标识，刷新后恢复查询；重试响应丢失时继续使用原 request_id，避免
重复创建任务。正常每 2 秒轮询，连接失败每 5 秒重连，终态或任务不存在时停止。状态未变化不重绘，
变化时保留详情展开与按钮焦点。销毁页面控制器后迟到响应不能重新启动轮询。

清除对话仅清除分析上下文，已提交的任务和卡片保留；已结束卡片可单独移除。Worker 离线明确展示等待
恢复状态，模型不可用不影响查询和取消。窄屏有任务时显示上下排列的结果工作区，避免沿用原窄屏隐藏
规则后无法操作任务。此切片不迁移 Agent 对话、同步或路线规划的执行方式。

验证包括请求格式、恢复轮询、断线和 404、过期响应丢弃、取消、失败子集幂等重试及跨刷新恢复、
与对话清除的交互。隔离浏览器预览使用真实组件和确定性任务替身，实测桌面与 390px 窄屏的失败详情、
重试、刷新恢复和取消；未调用真实模型或操作用户活动。

自动恢复次数耗尽时，failed/partial 任务允许重新提交 pending 与失败项，仍排除已经成功的活动。
实测 Windows 全量 Python 666/666、前端 402/402 和正常集成通过；WSL 报告展示、任务与独立进程相关
Python 35/35、前端 402/402 通过（Python 有 2 条第三方弃用提示）。

### 2026-09-09：阶段 6B-4 路线讲解迁入持久化 Worker

路线讲解不再由 `POST /api/route-narrations/prepare` 同步执行 Google Places 检索和模型生成。该接口现在只
校验输入、提交 `route_narration.v1` 任务并返回 HTTP 202；浏览器通过
`GET /api/route-narrations/jobs/{job_id}` 读取状态和最终讲解计划。Node 继续只做代理，提交和查询均使用
2 秒短超时，因此讲解耗时不会再占用 240 秒 Agent HTTP 请求。街景、骑行和设备控制不等待该任务。

SQLite schema 从 11 升至 12，新增 `route_narration_results`。完整 `route_narration_plan.v1` 只保存在专用
结果表，通用 `jobs.result_ref` 仅保存 job ID、plan ID 和路线 fingerprint。提交时同时固定 route
fingerprint 和完整规范化输入哈希；同一输入默认复用原任务，显式重试建立新任务。Worker 分别记录
`researching_places`、`composing_cards` 和 `saving_plan` 三个阶段，继续保持有限 Google Places 检索和
一次模型组合调用。

结果保存与当前领取凭证、租约、取消标记和完整输入哈希在同一事务内校验。Worker 若在专用结果提交后、
通用任务完成前退出，恢复执行直接复用已经保存的计划，不重复检索或调用模型。取消发生在结果提交前会
丢弃结果；已经完成原子提交的计划是专用查询接口的权威结果。前端同时校验任务与计划的 route fingerprint，
当前路线已经切换时拒绝加载迟到结果。

模型未配置时 Worker 返回脱敏的 `ai_unavailable`；其他生成异常统一为 `narration_failed`，不公开 provider
响应、模型原文、输入采样点或凭据。任务支持通用取消、最多三次租约恢复和显式强制重试。本切片没有迁移
AI 路线规划、Garmin/Strava 工作流或主 Agent 对话，也没有加入 TTS。

### 2026-09-09：单日路线自身重复约束

`create_route_plan` 与 `update_route_plan` 使用同一个 `route_constraints` 结构表达“不要原路返回”：
`avoid_repeated_roads` 控制是否强制执行，`maximum_self_overlap_ratio` 缺省为 10%。约束只在用户明确提出
时启用，未提出时不会改变已有路线的接受规则。

Python 路线服务对 Google、高德或 Strava 组合后的最终 LineString 做确定性检查。轨迹被重采样为短线段，
仅把空间接近、方向平行且在骑行进度上不相邻的后一次经过计为重复距离；垂直道路交叉不计入。环线起终点
附近最多 300 米、且不超过全程 3% 的共同接驳段被允许。超过阈值的候选以
`RouteCandidateRejected` 淘汰，并把实测重复率返回给 Agent，要求更换途经点重新算路。候选及 Agent 使用的
精简投影同时保存 `route_quality`，使“已理解用户要求”和“地图结果确实满足要求”成为两个可审查步骤。

### 2026-09-10：可选 Provider 与骑行能力解耦

Training Backend health contract 升级为 `training_backend_capabilities.v2`，分别投影 LLM、Google、AMap、
Strava、Garmin 和运动员档案状态。基础 FIT、活动详情、导入路线及自定义训练不依赖 LLM；国内 AI 路线
要求 LLM、Google 和 AMap，国外 AI 路线要求 LLM 和 Google。静态 Strava 配置与用户 OAuth 授权仍是
两个状态，不能用 client credentials 推断 Token 可用。

浏览器只从根 `config.yaml` 的统一运行时配置读取 Google Key，删除浏览器弹窗和 localStorage Key。
在线地图入口根据 capability 显示禁用原因；配置或请求失败时不再要求输入第二份 Key。完整功能关系见
[本地配置与功能能力矩阵](../feature-capability-matrix.md)。

路线增加 `elevationSource` 业务字段，将“有海拔可展示”与“海拔可信到可以控制骑行台”分离。
坡度模拟只接受 `gpx_embedded` 和 `strava_route`；Google 估算海拔标记为 `google_estimated`，仅用于
图表和路线概览。debug 不绕过来源校验。固定阻力、ERG 和自定义 ERG 课表允许无地理路线启动，
从而使未配置 Google 或 LLM 的本地安装仍能完成核心室内训练与 FIT 归档。

### 2026-09-10：本地路线骑行生命周期第一版

路线持久化策略集中到领域模块：GPX、AI 路线和地图选点路线在开始骑行前确保已经保存，并将 Python
返回的 `savedRouteId` 写入冻结的骑行 session；Strava 路线沿用导入时已经建立的本地身份。地图探索和
手工训练不自动保存，也不写路线进度。开始前保存失败不阻断骑行，但在骑行状态中保留明确警告。

正常结束后使用“续骑起点绝对距离 + 本次距离”更新 `route_progress`。Python 根据距离与终点 10 米容差
确定 `paused/completed`，不信任客户端自行声明完成；完成记录不再删除，因此路线库可以区分尚未骑行、
未完成和已完成。已完成路线禁用继续按钮，但仍可从起点重新开始；重新开始后提前结束会重新变为暂停。

本切片不实现异常退出恢复、周期 checkpoint、多次尝试历史或跨设备同步，相关边界继续由已知问题文档
跟踪。

### 2026-09-14：阶段 7A Python 浏览器 API 基础

阶段 7A 在不切换默认 `:8787` 入口的前提下，让 Python 首次实现既有 Browser API 的一个兼容子集：
`GET /healthz`、`GET /api/runtime-config/maps` 以及 `GET/PUT /api/user-profile`。这些路径与 Node 当前公开
路径完全一致，不新增第二套浏览器协议。用户档案接口只负责平铺 Rider settings 与规范运动员档案之间的
适配，并保留既有数值范围收敛和错误语义；地图配置继续只向本地浏览器提供 Maps JavaScript 必需的 Key，
占位配置按未配置处理。

Python 的 `/api/*` 增加浏览器入口前置防护：未携带有效 `X-API-Token` 时，Host 必须属于本地或显式配置
的 Rider 主机，Origin 若存在则必须属于本地应用来源。无 Origin 的 Node 内部代理仍按原有 loopback/token
规则访问；携带有效 Token 的显式服务端客户端保留远程访问能力。该边界同时防止恶意网页跨域调用本地
Garmin、Strava 和模型接口，以及通过非受信 Host 进行本地 DNS rebinding。

本切片没有提供静态前端资源、multipart FIT/GPX 上传或 Strava OAuth callback，也没有让浏览器改连
Python。Node 仍是正式入口，Python 新路径只通过同一份 Browser HTTP surface 基线和响应级回归证明协议
兼容。后续阶段 7 切片再逐项补齐静态资源、上传和 OAuth，全部对照通过后才进入端口切换阶段。

## 2026-09-18：Route Agent 材料准备与本地骨架

- 新增版本化材料与准备结果，独立 Route Agent 可在搜索后调用非终结准备工具。
- Python service 承接地点解析、可选 Strava 获取和有界骨架组合；不新增 Worker，不修改浏览器实时骑行。
- 地点骨架复用已解析坐标进入既有地图服务；Strava 混合骨架保持 pending，第三步再验证地图后端。
- 自由探索路网 owner 迁移记录在 `../known-issues-and-technical-debt.md`；尚未执行迁移。
- 详细范围与验证边界见 `../route-agent-implementation.md`。

## 2026-09-20：Agent 会话持久化与可见历史

- Python 继续拥有会话上下文与 SQLite 持久化，Node 仅代理新增会话 CRUD；数据库版本升级到 13。
- 主 Agent 与 AI 路线页面增加分类会话列表、恢复、切换、新建和删除；公开聊天记录独立于模型上下文和请求去重缓存。
- 修正内存 TTL 删除持久会话的问题，恢复失败时禁止继续发送，防止空界面隐式沿用旧上下文。
- 保留主对话路线卡片的会话归属；路线会话切换恢复草稿，新建后不再修改旧草稿。
- 不改变同步 Agent / Worker 边界，也不调整子 Agent 工具选择策略。协议、兼容旧记录及验证范围见 [`../agent-sessions.md`](../agent-sessions.md)。


## 2026-09-28：补记路线切片及阶段 7B 可选静态入口

`0545ba5` 已落地多日骑行草案、逐日生成/确认、独立失败结果和最后成功路线暂存，以及高德限流、会话删除与恢复修正。这些仍由 Python service/repository 持有，不代表主 Agent 或多日算路已经迁入 Worker；断网后的旧版本自动重试继续延期。

本轮新增 `docs/python-browser-entry-checklist.md`，按既有 Browser HTTP surface 的 48 项逐项记录 Python 同路径实现及缺失适配，不以路由存在代替响应级等价验收。

新增独立 `app.browser:app`，复用正式 `app.api` 路由、中间件与异常处理，仅将该可选入口的 `/` 换成仓库同一份 Rider HTML，提供受限的前端 JS/CSS 和 FIT SDK JS。默认 `app.api:app` 根路径仍为后端元数据，`npm start` 仍启动 Node BFF。预览命令 `npm run start:browser-preview` 复用统一配置、数据库预检和 Worker 编排，默认访问 Python :8000，不启动 Node server；启动器与依赖安装仍使用 Node/npm。

静态资源不挂载整个仓库，排除服务端代码、配置、用户数据、隐藏路径、符号链接和路径穿越；缺 SDK 返回 404。页面和资源用 no-cache 配合 ETag/Last-Modified/HEAD，不为未知路径回退 HTML。API Host/Origin/token 规则沿用阶段 7A。

本切片没有迁移 multipart 上传、OAuth state/callback 或补齐 Agent Browser URL。预览页面上的这些功能尚不完整，不作为日常 Node 入口的替代品，也不进入阶段 8 的端口切换。

验证：Python 静态入口/API/架构定向 83 项、JavaScript 453 项通过；正常集成新增 Node 与 Python 首页/CSS/启动模块/FIT SDK 字节级对照及缓存/私有路径检查，降级集成通过。Python compileall、Node syntax 和 git diff --check 通过。没有真实浏览器视觉、硬件或外部账号验收；未提交代码。


## 2026-09-28：阶段 7 multipart FIT 上传归属迁移

在可选静态入口之后，迁移现有 FIT import、attachment 和 beacon 三个 POST URL。Python 新增受限 multipart 边缘及 upload service；Node 保留 multipart 接收/转发，移除文件写入、活动 ID 生成和会话归档编排。默认 `npm start` 不变，不切换端口，不扩展 Worker 或 OAuth。

复用 ingestion 的单事务保存 FIT 事实、产物、路线关联，并允许原子合并 Rider 会话材料。独立不可变文件避免失败补传覆盖原文件；beacon 不再先归档半条活动。顺序重复上传复用当前同内容文件与稳定活动 ID；孤立旧文件自动回收不在本切片。

Python `rider_view.py` 统一页面活动投影；Node 详情读取改为请求 `view=rider`，原 canonical detail 默认契约不变。旧 JS 投影移为测试夹具，用真实 FIT HTTP 集成检查兼容性。

新增 python-multipart 依赖，单 FIT 32 MiB / Python 请求体 33 MiB 上限，包含无 Content-Length 的请求。缺文件、非法 session、坏 FIT、未知活动、数据库忙和权限拒绝均独立验证。详细范围和残余边界见 `../python-browser-entry-checklist.md`。

验证：Python 上传/ingestion/API/静态入口/架构/会话归档 106 项、JavaScript 454 项通过；真实 FIT 编码解析的 Node/Python HTTP 集成通过，后端离线上传返回 503 的降级集成通过。降级检查曾一次触发既有 health 的 3 秒阈值，未调整阈值，随后重新运行通过；不据此宣称压力下的时延保证。compileall、Node syntax、git diff --check 通过。测试使用临时数据库和生成文件，未操作外部账号；改动未提交。

## 2026-09-28：修复官方初始化的 multipart 安装缺口

上传迁移最初只更新 requirements.txt，官方 `setup:agent` 使用的 `pip install -e . pytest` 未声明 python-multipart，已有开发环境掩盖了缺包问题。现将同一运行时依赖加入 pyproject.toml，并用架构测试约束两份运行时依赖清单一致。

实际在新虚拟环境运行官方安装还复现了 setuptools 的多顶层包发现失败。补充明确的构建后端、源码包白名单及顶层模块，避免依赖自动发现本地 data/log 目录。忽略安装生成的 egg-info 元数据。

新增独立的 `npm run test:agent-setup`：官方脚本允许 `--venv` 指定测试环境，默认仍为原 .venv；冒烟脚本创建全新临时环境，执行官方安装、pip check、三个上传入口的 multipart 合约测试，结束后清理。该检查需要包下载网络，不纳入确定性 test:all。上传合约测试隔离 FIT 解析，不访问用户文件、地图、模型或账号。

验证完成：现有环境上传/架构定向 26 项、JavaScript 454 项通过；`npm run test:agent-setup` 在全新虚拟环境中实际执行官方 editable 安装成功，自动安装 python-multipart 0.0.32，pip check 无依赖冲突，三个上传入口的 14 项测试通过。安装期间包源出现过 SSL 重试，安装后的 pip 版本检查也因 SSL 跳过；均未阻止安装或测试完成。新 Starlette 的 TestClient 发出一条 httpx 弃用警告，未影响本次验证。临时测试环境已清理，原 Conda/.venv 未修改；语法检查和 git diff --check 通过，未提交。


## 2026-09-28：限定非 Agent 范围，补齐 Python 预览的 Strava 边缘

用户明确暂不处理 Agent 部分。阶段 6 剩余长任务、Agent Browser URL、会话执行与恢复、工具调用保持现状；本轮不迁入 Worker，不宣称流式进度已经提供持久恢复。

新增 app/strava_browser.py，仅在可选 browser 入口挂载，复用现有 StravaSink 与活动上传业务。补授权开始/回调/结果页面、浏览器字段与上传兼容 URL；不改变默认 Node 入口或内部 API 的既有调用契约。state 使用十分钟有效期、一次性消费、浏览器 Cookie 绑定，重启后过期；不是新增持久化任务。跨入口回调明确拒绝。Node OAuth owner 的删除/切换仍待完整等价验收。

验证：Python 定向 109 项、JavaScript 454 项及现有真实 HTTP 集成通过，新增两入口的 409/410、无效回调和登录页面对照；成功授权和发布参数使用隔离 Provider 验证，未执行真实授权或发布。compileall、语法和 diff 检查通过。真实浏览器视觉、Token 启用时的浏览器认证、其他响应适配和真实账号验收仍待处理，默认 npm start 与 :8787 不变。


## 2026-09-28：以产品融合为目标推进 Browser 适配与独立启动

用户明确核心目标是把 services/training-agent 融合进 Rider，而非扩大 Agent 工程重构。建立 `../backend-unification-goal.md` 作为本轮交付记录。允许 HTTP 边缘适配；模型循环、工具、路线算法及长任务恢复保持原状。没有改写冻结架构门槛。

新增 Agent 的八个 Browser URL，以及活动、路线、讲解和 Strava 目录/GPX 的参数与响应适配。仅在 app.browser 挂载；app.api 的既有内部契约保持。活动 FIT 详情使用 Python rider_view。基线 48 个 Browser 路径全部存在，但不将路径存在等同于全表分支验收。

Python 页面新增本机 HttpOnly 会话：Host/Origin 通过且客户端为本机才签发，配置中的服务 Token 不进入页面。内部 API 不接受此会话。验证伪造、跨站、远程来源、重启失效及显式 Token 访问边界。OAuth 保持单次 state 与独立 Cookie，不用此会话替代回调校验。

新增 `python scripts/start-rider.py`，使用当前 Python/Conda 环境，读取统一配置，执行既有数据库预检，管理 API 与 Worker 生命周期；支持独立 Worker 与指定端口/资源目录。自定义端口同步进入 Origin 校验。Node 旧配置适配过渡保留，使用合成配置对照测试；不声称配置兼容实现已经删除。新增 python-dotenv 并同步两份依赖声明。

新增 `scripts/build-browser-assets.py` 导出公开静态文件及 FIT SDK，拒绝覆盖既有输出或复制符号链接；manifest 记录哈希。Python 可从 RIDER_BROWSER_ASSET_ROOT/--assets 托管产物，运行不再要求源码 node_modules。当前仍是源码后端与独立前端产物组合，不是完整 wheel/容器发布。

验证：Python 定向 134 项通过，涵盖 API、上传、静态、会话、安全、Strava、架构、资源产物与启动。修正自定义端口后启动定向 5 项重新通过，实际临时数据库验证页面、带 Cookie 的 API 请求、Worker 注册、SIGTERM 退出及端口释放。前序双入口 HTTP 集成和 JavaScript 454 项通过，未改对应 JS 业务；compileall 与 diff 检查通过。外部服务采用隔离 Provider，未调用真实模型、地图或账号。

剩余：锁定依赖、完整发布/回退及 Windows 验收、真实浏览器/OAuth、全表异常与流式分支验收。冻结架构中的 Agent/Web 故障隔离未完成，不能据此删除 Node 或宣称完成阶段 8/9。默认 npm start 和 :8787 保留。本轮未提交、未推送。


## 2026-09-28：发布资源、依赖约束与回退补验

实际 wheel 打包发现 Skill Markdown 未声明为 package data；补声明后，在临时构建目录离线生成 wheel，再搬离源码加载全部 Skill 正文/参考资料通过。未修改 Agent 业务或提示词。

新增完整源码发布导出：前端公开资源、FIT SDK、Python 包、Skill 资源、启动/数据库预检脚本和示例配置组成同一 Rider 发布目录。明确排除实际配置、凭据、数据、Node server 和 node_modules。使用搬离仓库的产物真实启动 Web/Worker，页面/SDK、会话 API、Worker 注册及退出清理通过。产物仍需要已安装的 Python 依赖，不宣称独立可执行文件或 Windows 安装包完成。

依赖约束记录当前 Linux x86_64 / Python 3.13 的运行/构建/测试闭包；生成器不下载包、不读取配置、不冻结其他 Conda 包。约束一致性和 pip 离线 dry-run 通过，原环境未修改。约束不带制品哈希，未验证 Windows/其他 Python 版本。

独立启动器原先会因 Worker 退出而关闭 Web；按既有降级边界修正为提示任务不可用、保留 Web，仅 worker-only 模式将其视为致命错误。Linux 子进程故障注入已验证。集成测试配置进一步隔离 YAML、.env、凭据及工作流目录，Node 入口新增 RIDER_ENV_PATH 选择，默认行为不变。

实际同端口 Python→Node→Python 回退通过，共用临时 SQLite，无 schema 回退，活动/路线/会话读取以及回退期间档案写入保持。运行说明见 ../python-release-runbook.md。

本切片最终 Python 定向 137 项通过；正常 HTTP 集成（含同端口回退）与降级集成通过；compileall、Node syntax、diff 检查通过。未调用真实模型、地图、账号；没有进行 GUI 浏览器、设备、Windows 或兼容周期验收。目标仍为 active，冻结架构中的隔离等未通过门槛继续保留，不切换默认入口、不提交或推送。


## 2026-09-28：Browser 失败边界及真实 Edge 冒烟

继续核对两个入口失败语义：补 16 组实际 HTTP 错误状态与 JSON 封装对照，覆盖活动/路线/会话缺失与参数无效、缺模型能力、讲解参数和任务缺失；另验证两入口 NDJSON 能力拒绝只产生一个终止 error 事件。比较状态和公开响应形态，不宣称 Pydantic 与 Node 的错误文案逐字相同。

修正讲解适配把缺少 latitude/longitude/route_distance_m 当成零的问题，缺字段现在在任务提交前拒绝。catalog/narration 未预期异常保留 JSON 错误封装；Agent 预流式异常返回终止事件，非流式异常返回 500，公开响应不泄露内部异常文本。浏览器会话在响应期间可能被其他请求淘汰，签发 Cookie 时重新在锁内核对，避免旧缓存引用异常。

新增可选 scripts/test-python-browser-ui.py，使用已有 Chromium/Edge，不安装浏览器。实际 Windows Edge + WSL Python 测试通过：页面初始化、Cookie 授权、持久会话选择、删除弹窗取消/确认、新建草稿、FIT SDK 模块导入和缺地图配置降级。测试使用临时配置/SQLite/资源副本/浏览器 profile，结束清理；没有操作真实账号或设备。浏览器结果不代表 Windows Python 运行环境验证通过。

Python 定向 144 项通过，增强后的双入口 HTTP 集成与同端口回退通过；compileall、Node syntax、diff 检查通过。真实 OAuth、完整浏览器业务、Windows 后端和兼容观察仍未完成。下一步评估仅通过进程及 HTTP 编排补齐 Web/Agent 隔离；不改模型循环、工具选择、路线算法或新增任务恢复，不降低冻结门槛。未提交、未推送。


## 2026-09-28：通过运行边界隔离 Web 与同步 Agent

独立 Python 启动器现在管理 Web、私有 Agent HTTP 进程与既有 Worker。没有改模型循环、工具、路线算法，也没有新增 job/recovery 协议。私有 Agent 复用现有八个 Browser handler，拥有会话缓存和同步执行；Web 通过异步 HTTP 转发，基础活动/路线库/上传仍直接使用 Python 业务层。

私有服务只监听 loopback 临时端口，每次启动生成独立内部令牌。浏览器 Cookie、服务 Token 不向私有进程透传；经入口验证后用内部令牌认证。Web 的 /api/chat、/api/chat-sessions、/api/route-plans 原始别名在隔离模式下关闭，避免绕过边界。内部 app.api 契约和 Node 兼容启动方式保留。

API 的模型循环与路线 Tool 导入推迟到真正执行时；离开源码的 wheel 测试验证 Web 启动不加载这些执行模块。共享数据契约和上下文类型仍可被 Web 引用，不声称物理 namespace 整理完成。

代理不自动重试或重放。普通连接失败返回 agent_unavailable；NDJSON 校验终止事件，连接断开或流提前结束生成一次终止错误。原有业务在客户端断开后的行为不变，也不宣称进程崩溃后的同步任务可以自动恢复。Agent/Worker 退出时 Web 保留；Web 退出则启动器清理自己拥有的子进程。

真实浏览器首次重测暴露页面先于 Agent 就绪的启动窗口。增加最多约五秒的私有健康等待，Agent 故障仍允许 Web 启动；修正后 Windows Edge 的会话操作、SDK 和降级测试通过。

验证：Python 定向 151 项通过；修正就绪顺序后，启动/故障/私有边界 14 项再次通过。真实子进程终止 Agent 后，会话 API 为 503，而活动、路线库、档案为 200，内部别名为 404。增强 HTTP 集成已使用隔离的 Python Agent，并通过错误语义、流式终止和同端口回退对照。真实 Edge 冒烟通过，未调用实际模型/地图/第三方账号。

默认 npm start 和 :8787 未切换。阶段 6 的同步业务任务化仍未完成；完整 OAuth/浏览器业务、Windows 后端运行及兼容观察仍待验收。该切片证明执行进程隔离，不把它等同于 Worker 任务化、幂等发布或恢复。未提交、未推送。


## 2026-09-28：Windows 原生验证、框架兼容与请求边界

在 Windows Conda Python 3.13.9 上运行独立发布目录，未调用 Node。原环境缺少 multipart，使用临时 PYTHONPATH 中的纯 Python 包补齐测试条件，不安装或修改原 Conda；未下载包。原生环境使用 FastAPI 0.138.1 / Starlette 1.3.1，与 Linux 的 0.136.1 / 1.0.0 不同。

真实复现并修复两处跨环境问题：较新 FastAPI 以嵌套路由保存 include_router，原先挂载后筛选 app.routes 无效，首页误返回后端元数据；现改为挂载前筛选 canonical router，也避免私有执行别名重新出现。Starlette 在 Windows 返回内部反斜杠静态路径，原防穿越规则误拒绝 SDK；现先拒绝 URL 输入的反斜杠，再规范化框架内部路径，保持原私有文件/符号链接限制。

Windows 原生验收通过：HTML、Cookie、活动/路线/会话 API、SDK、非法 FIT 的 multipart 解析拒绝、Worker 注册。启动器响应 SIGBREAK；CTRL_BREAK 后 Web/Agent/Worker 三个自有子进程全部退出、端口释放。测试发布目录/配置/数据库/临时依赖均已清理。最后新增请求限额后，当前发布产物的 Windows 原生基础烟测再次通过。该验证不等同于 Windows 干净环境安装或真实账号测试。

开发安装新增 test extra，显式声明 pytest、setuptools、wheel、packaging，避免干净官方环境无法运行实际 wheel 构建测试；setup:agent 安装 .[test]，旧 requirements 路径保持同等依赖。当前 Linux 版本约束和 pyproject 指纹同步，离线 pip dry-run 通过，未更改当前环境。

补齐 Node 已有的普通 API 10 MiB 请求上限，包括缺少 Content-Length 的分块请求；只有真实 FIT multipart 路径交给既有 33 MiB 请求/32 MiB 文件限额。进一步统一 RIDER_DATA_ROOT 的相对环境变量：按项目根目录解析，不能因启动 cwd 改变而将派生数据库与文件目录分离；Node 兼容映射和 Python 映射对照通过。

验证：完整 test:all 的 JavaScript 454 项、Python 1067 项及正常/降级 HTTP 集成通过。此后请求限额定向 60 项、收紧 multipart 例外后的 9 项、配置/安装/启动 22 项及 JavaScript 454 项通过，增强 HTTP 集成再次通过。compileall、diff 检查通过。未执行真实 OAuth、地图、模型或账号操作。

切换门槛逐项记录于 ../backend-unification-goal.md。真实 OAuth 已询问用户配合时间；兼容使用观察尚未完成。目标仍为 active，不降低门槛，不自动切换默认入口、不提交或推送。

## 2026-09-28：Windows 干净安装补验

原生 Windows Python 3.13.9 的临时 venv 按独立发布说明安装成功，pip check 无损坏依赖；未继承已有 site-packages、未注入 multipart。首页/Cookie、活动/路线目录、私有 Agent 会话、SDK 与停止释放端口通过。临时目录已清理，未修改原 Conda 或业务数据。详细版本及限制见 python-release-runbook；FIT 导入和真实业务验收仍未完成。默认入口、Agent 业务逻辑未改，未提交或推送。

## 2026-09-28：Windows FIT 补验与外部验收边界

再次建立独立 Windows venv 并安装发布产物，pip check 通过。使用项目 FIT 导出器生成测试文件，经原生 Windows Python HTTP 验证导入、重复导入 identity/path、补传、beacon、详情 records 和坏文件 400 后原记录保留，全部通过。启动/停止检查亦通过，临时环境已清理；未读取用户 FIT 或账号数据。

剩余真实 OAuth、设备骑行和兼容观察需要用户参与，连续审计仍未取得证据。目标标为 blocked，不声明完成、不切换默认入口、不提交或推送。恢复后先取得对应验收结果，再对照冻结架构复核。

## 2026-09-28：按用户决定切换 npm 默认启动入口

用户明确要求现在直接切换，并保留回退。npm start 改为 start-python.js 薄包装，调用 Python 统一启动器的 --public-entry，沿用 Rider HOST/PORT 或 rider.host/port（默认本机 8787）；Python 管理 Web、私有 Agent 和 Worker。Node 不处理浏览器请求，旧 start-local.js 通过 npm run start:legacy 保留。控制管道 EOF 用于 Node 退出时通知 Python 正常清理，避免 Windows 强制结束父进程遗漏子进程。自动打开浏览器保留 APP_BASE_URL 或 localhost 公共地址习惯。

这次切换由用户明确决定，不声明冻结架构的所有删除门槛通过。Strava 登录收到用户通过反馈，但当时具体入口未核实；真实骑行及兼容观察仍待完成。未修改业务算法/模型循环、未删除 Node 服务、未提交或推送。

验证：启动/配置与进程生命周期测试 10 项通过，其中真实 Node 包装启动使用隔离配置和数据库，确认 Python 启动器及 Web/Agent/Worker 四个进程，停止后全部退出并释放端口。架构与 wheel 分发测试 13 项、JavaScript 455 项通过；语法检查和 git diff --check 通过。本轮未在真实账号/设备上运行新默认入口，未重新验证 Windows Node 包装路径。
