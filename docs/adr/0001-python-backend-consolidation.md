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

三个 Demo 目录继续保留实验算法、调试 Web 页面和 CLI；原 Provider 模块变成面向正式实现的兼容入口，
依赖方向固定为 `demo -> integrations/services`。本切片不改变公开 HTTP、路线 schema、数据库、候选选择
或前端行为，也不提前引入长任务 Job。阶段 6B 将在这个稳定 Provider 边界上单独实现持久化 Job、Worker
和轮询/取消协议。
