# Training Backend 结构债审计

## 1. 审计范围

本报告审计 Rider Tracker 内嵌 Python 服务：

```text
services/training-agent/
```

审计快照：

- 分支：`feat/embedded-training-agent`
- 初次基线提交：`1f8f46d refactor(ride): remove synthetic heart-rate model`
- 审计方式：目录、导入关系、HTTP 消费方、运行时路径、文档和测试的只读检查
- 初次审计本身不执行目录迁移、API 删除、数据库迁移或用户数据移动；补充复核只记录当前工作区结果
- 补充复核日期：2026-08-26；旧 Python Web UI 已由提交 `c9b4f35` 删除
- 补充复核已使用 Conda `py311` 完成 `335 / 335` Node 测试、`608 / 608` Python 测试、双进程
  health 集成、临时 schema v9 数据库检查和 Rider 页面启动冒烟

初次审计时该目录包含约 310 个受版本控制文件。主要代码规模如下：

| 目录 | 文件数 | 约代码行数 | 初次审计职责 |
|---|---:|---:|---|
| `agent/` | 61 | 8,043 | 主 Agent、活动分析 Agent、讲解 Agent、Skill、Tool、Presentation |
| `demo/` | 74 | 7,714 | 高德、Google、OSM/GraphHopper 路线实验，其中部分已被生产代码引用 |
| `services/` | 24 | 5,438 | 活动、路线、运动员、讲解业务服务 |
| `fit/` | 12 | 2,539 | FIT 解码和确定性活动分析 |
| `operations/` | 18 | 2,143 | Garmin、分析、上传、可恢复工作流 |
| `storage/` | 9 | 1,658 | SQLite schema 和 repositories |
| `app/` | 8 | 2,835 | FastAPI、CLI 和遗留静态前端 |
| `domain/` | 11 | 945 | 活动、分析、运动员和稳定契约 |
| `integrations/` | 5 | 874 | Garmin、Strava、Google Places、LLM |
| `evaluation/` | 10 | 968 | Skill/Tool 评测 |
| `tests/` | 64 | 10,738 | Python 回归测试 |

> 行数用于定位热点，不应作为机械拆文件的依据。表中保留初次审计快照；提交 `c9b4f35` 已删除
> `app/static/`、`tests/test_web_ui.py` 等遗留 Web UI 资产，因此文件数和 `app/` 行数已经下降。

## 2. 总体判断

`services/training-agent` 的名称已经不能准确描述它的职责。它目前不是单纯的 Agent，
而是已经承担 Rider 大部分后台业务的 Python Backend，负责：

- FIT 解码、指标和特征提取；
- 活动导入、详情、历史、报告和工作流；
- SQLite schema 与 repository；
- Garmin、Strava、地图和 LLM 集成；
- 路线规划和路线讲解；
- Agent、Skill、Tool 和结构化 Presentation；
- FastAPI、CLI 和后台任务。

当前架构不应描述为两个独立产品，也不是真正可以独立部署的微服务。它更接近一个
**单仓库、双运行时、双进程的模块化单体**：Rider 与 Python Backend 共用配置、SQLite、FIT
文件目录和启动生命周期，但通过内部 HTTP 保持进程隔离。

### 2.1 最终运行边界

正式决策见 [ADR 0001](./adr/0001-python-backend-consolidation.md)。目标不是把整个项目改成单一语言，
而是让 Python 成为唯一业务后端，JavaScript 专注浏览器应用和实时骑行：

```text
Browser JavaScript
  - UI / 地图 / Web Bluetooth / FTMS
  - 骑行物理、实时状态和 runtime route
          |
          | 同源 /api/*
          v
Rider Python Backend :8787
  - 正式 Rider 页面与 FastAPI
  - Activity / Route / Athlete / Workflow
  - SQLite / FIT / Garmin / Strava / 地图 provider / LLM
  - Training Agent / Skill / Tool adapter / Presentation
```

Node/Express 在迁移期继续作为 BFF，逐个代理已经迁到 Python 的浏览器 API；它不是目标结构中的
长期业务层。只有完成同源安全、OAuth、文件接收和所有数据库 API 的等价迁移后，FastAPI 才接管
`:8787` 和正式 Rider 页面，Node 退出生产运行时。

这不是一次性重写：

- Web Bluetooth、FTMS 和实时骑行本来就在浏览器，改服务端语言不能减少这部分 JavaScript。
- Python 已有 FIT、Agent、训练分析、路线、Garmin、Strava、Workflow 和 600 多项测试；迁移 Node
  的有限后台职责比把这些能力重写成 JavaScript 风险更低。
- Node 当前的同源、Origin、OAuth 和上传能力必须先在 Python 建立等价测试，不能先删再补。
- 最终即使只有一个对外服务，慢 Agent/Provider 任务仍应通过 job/worker 与基础 API 隔离。
- `npm start` 继续作为统一入口；最终它只负责定位 Python、检查配置并启动一个 Backend。

### 2.2 三种方案比较

| 方案 | 收益 | 主要代价和风险 | 判断 |
|---|---|---|---|
| 保留当前双写结构 | 不迁移、近期风险最低 | Node/Python 共同写 SQLite，契约、DDL 和事务继续漂移 | 只适合作为迁移起点 |
| 浏览器 JS + 薄 Node BFF + Python 主后端 | 可以按 API 纵向切片迁移并保持 URL | 迁移期仍有两个服务端进程 | 必要过渡态 |
| 浏览器 JS + Python 唯一业务后端 | 单一持久化和后台 owner；单端口；便于本地和桌面打包 | 必须补齐 Node 现有安全、OAuth、上传和静态托管行为 | 推荐终态 |
| 全量改为 JavaScript | 表面语言统一 | 重写成熟 Python 领域能力并丢失既有测试价值 | 不采用 |

### 2.3 推荐职责 owner

| 能力 | 推荐 owner |
|---|---|
| UI、地图展示、Web Bluetooth、FTMS | Browser JavaScript |
| 骑行物理、readiness、trainer command、runtime route | Rider JavaScript Domain |
| 静态资源、同源入口、Origin/Auth | 迁移期 Node；最终 FastAPI |
| FIT 历史解析、Agent、路线规划、路线讲解 | Python Backend |
| Garmin、Strava、LLM、可恢复长任务 | Python Backend |
| SQLite schema、migration、repository 和跨表事务 | Python Backend |
| 浏览器与 Backend 数据格式 | 版本化 OpenAPI / JSON Schema 契约 |

Node BFF 只在迁移期保留，不应新增数据库或后台领域实现。前端构建、测试和依赖管理仍可继续使用
Node，这与“Node 退出生产后端运行时”并不冲突。

### 2.4 当前结构债优先级

当前最重要的结构债依次是：

1. Python 正式业务仍被包在 `services/training-agent`，业务后端与 Agent 的物理边界相反。
2. Node 与 Python 同时直接写共享 SQLite；Python 虽是 migration owner，但还不是唯一持久化 owner。
3. 正式路线服务反向依赖 `demo/`，Google/Strava provider 仍有重复实现。
4. `operations/activity`、`services/activity`、`fit/analysis` 的职责边界仍有兼容门面和反向包装。
5. Agent 路线仍从通用 Presentation 反向拼装领域数据，确认、revision 和异步响应缺少 fail-closed
   契约。
6. 运行时相对路径可能在服务源码目录中生成第二份 Token、工作流、日志或数据库。
7. 迁移期 Agent 是 Rider 启动和存活的硬依赖，故障会连基础骑行入口一起停止。
8. Python 服务名称、包名、客户端名、环境变量和数据库名不一致。

旧 Python Web UI 已由提交 `c9b4f35` 删除并完成自动回归；真实 Garmin、Strava 和路线 Provider
仍需在具备凭据的环境手工验收。

推荐先冻结跨进程契约和依赖方向，再迁入根 `src`；随后按纵向 API 切片迁移事务 owner，最后删除
Node 生产后端。目录移动本身不是目标，移动后依赖方向和 owner 必须同时变得可验证。

## 3. FIT 代码是否应直接搬到外层

### 3.1 已确认的当前链路

历史 FIT 已经只有一条生产权威链路：

```text
FIT 文件
  -> services/activity/fit_loader.py
  -> fit/parser.py
  -> fit/analysis/*
  -> activity_facts / activity_artifacts
  -> Rider activity detail / Agent analysis
```

- `fit/parser.py` 使用 `fitdecode` 解码完整 FIT。
- `fit/analysis/*` 生成确定性指标、区间、跑步动态和候选特征。
- `services/activity/fit_loader.py` 注入统一运动员档案。
- `services/activity/ingestion.py` 保存活动身份、facts 和 UI detail artifact。
- Rider JavaScript 只保留实时记录、FIT 导出和 Python 结果的页面适配，不再权威解析历史 FIT。

因此现在没有“两套历史 FIT parser”需要再次合并。

### 3.2 不推荐的做法

不建议把 FIT 单独放成仓库根目录的松散包：

```text
rider-tracker/fit/
```

原因：

- 它会绕过统一的根 `src` 源码树；
- FIT 导入仍需要运动员档案、活动 repository 和 artifact 持久化，并不是独立进程；
- 当前没有第二个 Python 服务需要直接复用这个包；
- 只移动物理路径不会解决 decoder、纯算法和应用编排混杂的问题。

### 3.3 推荐边界

FIT 随 Python Backend 迁入根 `src`，按职责拆分，而不是继续作为 Agent 的子模块：

```text
src/
├── infrastructure/fit/
│   ├── decoder.py          # fitdecode、文件读取、原始消息标准化
│   └── paths.py
├── domain/activity/
│   ├── metrics.py          # 纯确定性指标
│   ├── features.py         # 冲刺、爬坡、强度候选
│   ├── segments.py
│   └── running.py
└── application/activities/
    ├── ingestion.py        # 档案注入、身份建立、持久化
    ├── detail.py           # activity_detail.v1
    ├── history.py
    └── reporting.py
```

迁移原则：

- 文件系统和 `fitdecode` 属于 `infrastructure/fit`。
- 不依赖网络、SQLite 和 Agent 的确定性算法属于 `domain/activity`。
- 组织解析、档案、repository 和 artifact 的用例属于 `application/activities`。
- HTTP、CLI、Agent Tool 和 Workflow 只能调用 application service，不能直接调用 decoder。

只有未来确实出现第二个 Python 服务需要复用活动算法时，再抽取
`packages/activity-core-py/`。当前不应为了形式新增第三个服务或进程。

## 4. 双前端（已完成删除）

### 4.1 初次审计事实

初次审计时 Training Agent 仍维护 `app/static/`、`tests/test_web_ui.py` 和一组只供旧页面消费的
Dashboard、Garmin、FIT、报告与上传 API。它们与 Rider 页面重复渲染 Presentation、路线地图和
Strava 状态，是当时优先级最高、风险最低的删除目标。

### 4.2 当前状态

提交 `c9b4f35` 已按
[`remove-training-agent-legacy-web-ui-plan.md`](./remove-training-agent-legacy-web-ui-plan.md)
完成主要删除：

- `services/training-agent/app/static/`、`tests/test_web_ui.py` 和旧主视觉已删除；
- Python `/` 改为只返回服务信息 JSON，不再渲染产品页面；
- 旧 Dashboard、Garmin、任意 FIT 路径分析、summary 和旧 Strava upload HTTP 兼容入口已删除；
- Garmin、FIT、报告和 Strava 的底层 application/operation 能力仍保留；
- Python 独立 CI 已并入根 CI，Rider 成为唯一浏览器入口。

当前拓扑已经明确为：

```text
Browser -> Rider Node :8787 -> Python Backend :8000
```

Rider 必须保留的 Python API 为：

- `/health`
- `/api/chat`
- `/api/activities/ingest-fit`
- `/api/activities/{activity_id}/detail`
- `/api/athlete-profile`
- `/api/strava/config`
- `/api/strava/connection`
- `/api/strava/auth-url`
- `/api/strava/exchange-code`
- `/api/strava/upload-activity`
- `/api/strava/upload-status/{upload_id}`
- `/api/route-plans/select`
- `/api/route-plans/command`
- `/api/route-narrations/prepare`

### 4.3 剩余验收

这项工作尚不能仅凭文件删除视为完成，仍需：

- 检视当前未提交 diff，确认没有误删 Rider 正在消费的 Python API；
- 运行 Python 全量回归和真实双进程集成测试；
- 在浏览器手工覆盖 Garmin 快捷入口、FIT 导入/详情、Agent Presentation、路线规划和 Strava；
- 确认 `127.0.0.1:8000` 不再暴露 HTML、静态资源和旧兼容 API；
- 作为独立变更提交，不与 namespace、数据库 schema 或公开 URL 改名混在一起。

## 5. 正式路线服务依赖 Demo

### 5.1 已确认事实

`demo/__init__.py` 明确声明：

```python
"""Isolated experiments; production modules must not import from here."""
```

但以下正式模块直接导入 `demo.*`：

- `services/route/single_day.py`
- `services/route/popular_loop.py`
- `services/route/segments.py`
- `services/route/segment_aware.py`

被引用的能力包括：

- 高德地点/骑行算路；
- WGS84/GCJ02 坐标转换；
- Google Places/Routes；
- haversine 和 polyline；
- Strava Segment Explorer、详情几何和路段拼接。

这意味着 `demo/` 中已有一部分其实是未迁移的生产 provider，而不再是实验代码。

### 5.2 目标结构

```text
infrastructure/providers/
├── amap/
│   ├── places.py
│   ├── routes.py
│   └── coordinates.py
├── google/
│   ├── places.py
│   ├── routes.py
│   └── elevation.py
└── strava/
    ├── client.py
    └── segments.py

domain/route/
├── geometry.py             # haversine、polyline、闭合判断
├── candidate.py
└── composition.py
```

迁移后只能存在以下依赖方向：

```text
demo/experiments -> 正式 provider/domain
正式 application -> 正式 provider/domain
```

禁止：

```text
正式 application/services -> demo
```

应增加架构测试，扫描生产包是否包含 `from demo` 或 `import demo`。

真正实验性的 OSM/GraphHopper Web Demo 可最终移到仓库根目录：

```text
experiments/route-planning/
```

避免它随 Python Backend 一起被当作生产源码部署。

## 6. 重复 Provider 与 owner

### 6.1 Google Places

当前存在两份实现：

- `integrations/google_places.py`：路线讲解 Agent 使用；
- `demo/global_cycling_router/google_places.py`：正式路线服务间接使用。

应合并为正式 Google provider。地点搜索、附近偏置和字段映射可以使用明确参数，
不应通过复制 client 区分场景。

### 6.2 Strava

`integrations/strava.py` 已负责 OAuth、Token 和活动上传；
`demo/osm_cycling_router/strava_segments.py` 又维护 API 请求、TLS fallback、重试、
Segment Explorer、详情和 polyline decode。生产路线直接依赖后者。

需要把生产所需 Segment 能力迁入正式 Strava provider。

`StravaSink` 实际同时读写，名称不准确，建议最终重命名为 `StravaClient`。

### 6.3 SQLite schema

当前正式迁移入口是：

```text
npm run db:migrate
  -> scripts/database-tool.py
  -> storage.database.initialize_database()
```

方向正确。但 Node 的 activity/route store 仍保留 standalone 建表 fallback，并直接写
`activities`、`saved_routes` 和 `route_progress`。Python 同时写 activities 派生事实、报告、
路线计划和会话，当前因此不是纯 HTTP 解耦，而是两个进程共同操作同一个数据库和文件目录。

SQLite WAL 对当前本地低并发产品足够，但同一时刻仍只有一个 writer。当前首要风险不是吞吐量，
而是跨进程事务、表级 owner 和 DDL 漂移：

- Python 确认路线与 Node 保存 `saved_routes` 不是一个事务；
- Node 保存 FIT 路径后再由 Python ingestion，失败时需要补偿中间文件和活动状态；
- 任一侧扩展对方表，都可能绕开对方 repository 中的业务不变量；
- 一旦改为远程 Agent、容器分离或多实例，共享 SQLite 与共享路径将不再成立。

目标是 Python 同时成为 schema owner 和持久化 owner。迁移应按表和用例逐步进行，保持浏览器
`/api/*` URL 不变，让 Node route 先变成代理，验证稳定后再删除对应 store。

第一步应删除 Node standalone DDL，只保留明确错误：

```text
数据库缺失或版本不符，请执行 npm run db:init / npm run db:migrate
```

中期再依次迁移：

1. `saved_routes` / `route_progress` CRUD 与“确认并物化路线”事务；
2. activities 列表、改名、删除和骑行归档；
3. FIT 文件 metadata 与 ingestion 的一致性处理；
4. Node 中最后的 `DatabaseSync` 调用和数据库环境变量。

Node 可以暂时保留受控目录中的 FIT 安全落盘或上传流转，但不能再同时成为活动数据库 owner。
完成该阶段后，Node 只通过 Python API 访问持久化状态。

### 6.4 Agent 路线跨进程契约

当前 `agent_turn.v1` 和 `presentation.v1` 已经是版本化公开契约，但 Rider 的路线领域仍从通用
Presentation 中反向拼装：

```text
Python route plan
  -> presentation table + route_map
  -> JS parseAgentRouteDraft()
  -> buildMapDrawRoute()
  -> Rider runtime route
```

这条链路存在以下高优先级问题：

1. `parseAgentRouteDraft()` 会收集一轮中的所有 `route_map` 并按 `candidate_id` 合并；如果一轮有
   多个路线 execution 或多个 plan，可能混合不同计划的状态和几何。
2. 候选表没有始终携带 `candidate_id`，JS 会退回按展示名称关联 metadata；同名候选可能错误合并。
3. 路线 command 返回 `{answer, result, presentations}`，但没有独立公开版本；JS 又把它手工包装成
   turn result 后解析 Presentation，形成第二套隐式协议。
4. `confirmAgentRoute()` 当前会在 command 返回后无条件设置 `isDraft=false`，没有同时验证
   `planning_status`、`confirmed_candidate_id` 和请求 candidate 是否一致。
5. select、confirm、reverse、undo、compose 缺少 `request_id` 与 `expected_revision`；网络重放或
   并发响应可能重复撤销/反转，或者用旧 draft 覆盖新 revision。
6. Python route plan 确认与 Node `saved_routes` 写入不是一致性操作，保存失败时会留下已确认但未
   物化的路线。

推荐增加独立领域 DTO，而不是继续扩大 Presentation：

```text
route_plan_view.v1
  plan_id
  revision
  planning_status
  active_candidate_id
  confirmed_candidate_id
  schedule_type
  country_code
  candidates[]
    candidate_id
    parent_candidate_id
    name
    distance_m
    provider_duration_s
    provider
    travel_mode
    geometry              # WGS84 GeoJSON LineString [longitude, latitude]
    waypoints[]
    segment_overlays[]

saved_route.v1
  saved_route_id
  source
  name
  geometry
  total_distance_m
  elevation_status
  agent_plan_id
  agent_candidate_id
```

`presentations` 继续服务通用 Agent UI；`route_plan_view.v1` 服务 Rider 路线领域。Python 应使用
Pydantic response model 将它纳入 OpenAPI，Node/Browser 在边界严格验证 schema version、枚举、
坐标顺序、距离单位、plan 唯一性和资源上限。

Python/SavedRoute 保存 provider 无关的几何和 metadata；Browser JavaScript 再通过通用 route builder
创建 runtime snapshot。虚拟骑行 `25 km/h` 预计时间、无海拔路线按平路处理等运行时策略继续由 Rider
JavaScript 决定，不应为了统一持久化 owner 又在 Python 复制一套实时骑行规则。

路线确认必须 fail-closed：只有 response revision 仍是预期 revision，且 confirmed/active/requested
candidate 三者一致时才能生成可骑行路线。所有异步 route command 还需要统一的 loading/request ID、
骑行开始后二次检查和 stale response 丢弃。

`agent-route-contract.js` 当前通过 `buildMapDrawRoute()` 构建 Agent 路线，再覆盖 Google/source
字段。应抽出 provider 无关的 `buildCoordinateRoute()`；Google map-draw 和 Agent 各自只做外部
格式适配，避免把 Agent 路线伪装成地图绘制路线后再修补 metadata。

### 6.5 故障隔离、长任务与本地安全

当前根启动器先等待 Python `/health`，成功后才启动 Rider Node；任一子进程异常退出又会停止全部
进程。这使可选的 Agent 能力成为 GPX、设备连接、ERG 和实时骑行的硬依赖。

推荐改为：

- Rider Node 始终可启动，Python 不可用时 Agent/分析/路线/Strava 返回明确的
  `503 agent_unavailable`；
- GPX、地图、设备、ERG、模拟与实时骑行继续可用；
- 启动器独立展示 Rider 与 Python readiness，可重启 Python，但不因 Agent 崩溃结束 Rider；
- UI 显示能力级降级状态，不能把 Agent 健康错误解释成整个 Rider 不可用。

Python API 中的 path operation 当前使用普通 `def`，FastAPI 会在线程池中执行这些 handler；因此
更准确的风险是 30-240 秒任务长期占用 worker/thread、没有进度与取消，而不是单个同步 handler
必然冻结整个事件循环。短期可以保留 request/response，后续对训练报告、同步和复杂路线采用：

```text
POST job -> 202 + job_id
GET job status 或 SSE events
POST job cancel
```

同时为 Browser -> Node -> Python 统一传播 `X-Request-ID`，记录 endpoint、session/plan/job ID、
耗时和错误类别。

Node 默认监听 `127.0.0.1`，Python Token 也只由 Node 注入，这是当前应保留的安全边界。若未来允许
LAN 或 `0.0.0.0`，不能只依赖 Origin：无 Origin 的非浏览器请求也必须经过认证、Host 校验和明确
授权。

## 7. 运行时路径债

Python 进程以 `services/training-agent` 为 cwd，以下默认相对路径可能写入源码目录：

- `data/activity_runs`
- `data/runs`
- `data/personal-fit-agent.db`
- `data/strava-tokens.json`
- `data/athlete.json`
- `log/`
- `garmin_cn_fit_files/`
- `evaluation/artifacts/`

根启动器已经覆盖数据库和 FIT 的主要路径，但并非所有模块都使用 `RIDER_PROJECT_ROOT`
或 `resolve_project_path()`。尤其 `integrations/strava.py` 直接把配置中的
`data/strava-tokens.json` 转成 `Path`，会相对 Python cwd 解析。

建议建立唯一 `runtime_paths.py`，全部运行时路径从 Rider 根目录推导：

```text
data/
├── rider-tracker.db
├── files/fit/
│   ├── garmin/
│   ├── imported/
│   └── rides/
├── credentials/
│   ├── strava-tokens.json
│   └── garmin/
├── workflows/activity/
├── logs/training-agent/
└── cache/activity-artifacts/

artifacts/
└── evaluation/

tests/fixtures/
├── fit/
├── gpx/
└── contracts/
```

归属规则：

- `data/`：用户状态，不提交；
- `artifacts/`：可删除的评测/性能输出，不提交；
- `tests/fixtures/`：最小、脱敏、确定性测试数据，可以提交；
- `evaluation/cases/*.jsonl`：评测输入，继续提交；
- `demo` 的 PBF、GraphHopper cache：实验数据，不放源码目录。

Token 迁移必须显式检测冲突，不能静默选择某一份或覆盖内容。

## 8. 命名问题

### 8.1 产品与服务名称

目前同时存在：

| 类型 | 当前名称 |
|---|---|
| 产品 | Rider Tracker |
| 物理目录 | `services/training-agent` |
| Python project | `personal-fit-agent` |
| FastAPI title | `Personal FIT Agent API` |
| 环境变量 | `PERSONAL_FIT_AGENT_URL` |
| Node client | `createPersonalFitAgentClient` |
| 默认数据库 | `personal-fit-agent.db` |

迁移期间统一概念：

- 产品：Rider Tracker；
- Python 服务：Rider Training Backend；
- 对话能力：Training Agent；
- Python 正式源码：根 `src/api`、`src/application`、`src/domain`、`src/infrastructure`、`src/agent`；
- Node client：`trainingBackendClient`；
- 新环境变量：`TRAINING_BACKEND_URL`；
- 数据库：`rider-tracker.db`。

旧环境变量需要至少一个兼容周期，并输出 deprecated 日志，不能立即删除。

### 8.2 `activity_key` 与 `activity_id`

数据库是 `activities.id`，HTTP 使用 `{activity_id}`，Python dict 和大量函数仍使用
`activity_key`。

建议对外和新领域代码统一为 `activity_id`；`activity_key` 只作为旧输入兼容别名。
数据库主键无需因此迁移，也不要在目录重构时同时修改公开 API。

### 8.3 报告 schema 名称

完整报告同时出现：

- 常量：`ACTIVITY_REPORT_V2`
- 旧别名：`SUMMARY_SCHEMA_V2`
- 实际持久化值：`llm_fit_file_analysis.v2`

数据库值暂时保持不变，新代码只能引用 `ACTIVITY_REPORT_V2`。实际字符串改名必须通过显式迁移，
不能和目录移动混在一起。

### 8.4 目录和文件命名

- `agent/main_agent`：双重 Agent 语义，可在 namespace 重构时改为 `agent/main`。
- `agent/tools/agent_tools.py`：名称重复，适合按活动、路线、控制等 catalog 拆分。
- `fit/analysis/data.py`：`data` 过于宽泛，应按 summary/query/series 等职责拆分。
- `operations/activity/service.py`：既叫 operation 又叫 service，并聚合同步、分析、上传。
- `services/activity/*` 与 `operations/activity/*`：一个偏查询/领域服务，一个偏副作用工作流，
  但当前存在互相包装，应收敛到 application use case。
- `app/api.py`：删除旧 Web API 后已降至约 400 行，但仍混合多个资源；应在公开 response contract
  稳定后按 HTTP resource 拆 route modules。

## 9. 过时资产清理状态

### 9.1 文档

提交 `c9b4f35` 已同步整理主要文档资产：

- `AGENT_STRUCTURE.md` 已描述 `/api/chat`、正式路线服务和 `presentation.v1` 当前链路；
- `README.md` 已明确 Rider 是唯一浏览器入口，Python 只提供 Backend、Agent、CLI 和内部 API；
- `DATABASE.md`、`CLAUDE.md` 已按单仓和共享数据库方向更新；
- 子目录 `.github/workflows/test.yml` 已删除，Python 测试并入根 CI；
- 旧独立服务 `figure.png` 已删除。

长期仍应把 `CLAUDE.md` 中通用的工程规则迁入仓库统一说明，避免出现另一份只对 Python 子目录
有效的产品架构。

### 9.2 运行时文件

本地 `services/training-agent/data/`、`log/`、`evaluation/artifacts/` 和缓存目录虽然多数已被
`.gitignore` 排除，但它们证明运行时路径仍会落入源码容器。应迁移数据后清理，不应直接删除
可能含 Token、工作流或用户活动的数据。

## 10. Dead code 与兼容债候选

以下是清理候选，不代表可以不经回归立即删除：

1. `services/route/advice.py` / `generate_route_advice`
   - 当前 Skill 不暴露；
   - 测试明确断言它不可达；
   - 主要由旧单测和 evaluation sandbox 维持。

2. `casual_chat` / `ask_user_clarification`
   - handler 和 ToolDef 存在；
   - Skill 路径不可达；
   - 普通聊天当前由模型直接回答。

3. `storage/paths.py`
   - 只是 `project_paths.py` 的兼容 re-export；
   - 应确认没有外部调用后删除。

4. `operations/activity/service.py`
   - 同时实现同步、分析和上传；
   - `sync.py`、`reporting.py`、`upload.py` 又反向调用它；
   - 应把实现移动到对应 operation 后删除兼容大门面。

5. `agent_loop`
   - 当前是 `execute_tool_loop` 的兼容包装；
   - evaluation 和部分测试迁移后可收紧。

6. route plan 中的旧 `route_type`
   - 新代码可从首尾点派生；
   - 仍可能存在旧持久化计划，需 migration 后才能删除。

## 11. 大文件热点

以下文件均超过约 600 行：

- `storage/repositories/activity.py`
- `services/route/segment_aware.py`
- `agent/analysis/agent.py`
- `fit/analysis/data.py`
- `services/route/single_day.py`
- `agent/runtime/presentation_projector.py`
- `agent/tools/agent_tools.py`
- `agent/tools/handlers/route.py`

拆分建议：

- repository 按 catalogue/report/facts/artifact 拆；
- route 按 provider 调用、候选验证、路段组合拆；
- analysis agent 按 prompt/context/tool-loop/result 拆；
- presentation projector 按 presentation kind 拆；
- ToolDef 按 Skill/category 拆 catalog；
- API 按 HTTP resource 拆 router。

必须先稳定依赖边界，再拆大文件，避免只是把循环依赖分散到更多文件。

## 12. 推荐目标目录

`src/` 是 Rider 唯一正式源码树。Python 后台代码不再长期留在名为 Training Agent 的服务目录，
也不额外套一层笼统的 `training_backend/`；它按职责迁入根目录：

```text
src/
├── ui/                         # JavaScript 浏览器 UI
├── app/                        # JavaScript 浏览器应用编排
├── adapters/                   # JavaScript 浏览器 I/O adapter
├── domain/
│   ├── ride/                   # JavaScript 实时骑行
│   ├── metrics/                # JavaScript 实时指标
│   ├── activity/               # Python FIT、活动事实和训练领域
│   ├── athlete/                # Python 运动员领域
│   ├── contracts/              # 稳定协议；跨语言实现由 contract test 对齐
│   └── route/
│       ├── runtime/             # JavaScript 地图与骑行运行时
│       └── planning/            # Python 路线规划领域
├── application/                # Python 活动、路线和 Workflow use case
├── infrastructure/
│   ├── runtime_paths.py
│   ├── persistence/             # SQLite migration 与 repositories
│   └── providers/               # Garmin、Strava、地图与 LLM
├── agent/                       # Python 对话、Skill、Tool adapter、Presentation
├── api/                         # Python FastAPI 与 routers
├── cli/                         # Python 运维入口
└── server/                      # 迁移期 Node BFF；最终退出生产运行时

tests/
├── backend/                     # Python 测试
├── contracts/                   # 跨语言 fixture / schema / API snapshot
└── unit|integration/            # JavaScript 测试

evaluation/                      # Agent 评测代码与提交的 cases
experiments/                     # 不允许被生产代码 import 的实验代码
```

同一个业务目录出现跨语言实现时必须按职责再分层，不能依靠 `.js` / `.py` 扩展名区分语义。
例如路线的 Browser runtime 与 Backend planning 明确分开。源码移动使用 `git mv`，但不得在同一
提交同时修改公开 API、升级数据库或迁移用户数据。

## 13. 分阶段迁移

### 阶段 0：冻结边界并增加护栏

- [x] 合入旧 Python Web UI 删除和本报告；
- [x] 用 [ADR 0001](./adr/0001-python-backend-consolidation.md) 固定“Browser JavaScript + Python
  唯一业务后端”的终态，并声明 Node 只是迁移期 BFF；
- [x] 保留稳定 schema 注册表和 Python 内部 API 精确路径测试；
- [x] 增加生产代码 `demo` import 基线测试：允许已知历史依赖，但禁止债务继续增长；
- [x] 建立浏览器当前对外 HTTP method/path 的机器可读迁移基线，并用架构测试锁定；
- [ ] 给上述 API 补齐 request/response/error contract fixture；
- [ ] 生成并审阅 OpenAPI snapshot，明确内部 API 与最终浏览器 API 的兼容关系；
- [ ] 统一错误 envelope、schema version、`request_id` 和 correlation header 的规则；
- [ ] 补真实双进程 FIT、路线和 Backend unavailable 测试；
- 本阶段不移动生产代码。

### 阶段 1：完成双前端删除验收

- 详细实施步骤见 [`remove-training-agent-legacy-web-ui-plan.md`](./remove-training-agent-legacy-web-ui-plan.md)；
- 提交 `c9b4f35` 已完成代码、文档和 CI 整理；
- 运行 Python 全量回归与双进程测试；
- 浏览器手工验收 Garmin、FIT、Agent、路线、报告和 Strava；
- 保持 Rider 所用 API URL 不变；
- 独立提交当前删除，不同时改 namespace、数据库版本和公开 URL。

### 阶段 2：建立根 `src` Python 边界

- 在根 `src` 建立 Python `api`、`application`、`infrastructure`、`agent` 和 `cli` package；
- 调整 `PYTHONPATH`、pytest、CLI、启动器和 CI，使新旧 package 在迁移期可同时导入；
- 第一条纵向切片只迁移 contracts、配置和 `runtime_paths.py`，不改变行为；
- 建立根 `src/domain` 的跨语言目录规则，路线明确拆为 runtime 与 planning；
- 所有临时 re-export 写明调用方和删除条件。

### 阶段 3：迁移 Python Domain 与正式 Provider

- 使用 `git mv` 将 FIT、活动、运动员、稳定 contract 和路线 planning 迁入根 `src/domain`；
- 将生产使用的高德、Google、OSM 和 Strava Segment 实现迁入 `src/infrastructure/providers`；
- Demo/实验反向调用正式模块，生产代码的 `demo` import 基线逐项归零；
- Domain 不依赖 Agent、FastAPI、SQLite、文件系统或 Provider；
- 保持活动、路线 schema 和 HTTP URL 不变。

### 阶段 4：统一 Application、Workflow 与运行时路径

- 将现有 `services/` 与 `operations/` 收敛为 activity、route、workflow application use case；
- Agent Tool、CLI 和 API 都调用同一 use case，不直接访问数据库、文件或 Provider；
- Strava Token、Workflow、日志和评测 artifact 统一从 Rider data root 推导；
- 只读检查并显式迁移子目录中的旧 Token、数据库和 workflow；
- Python migration 成为唯一 schema owner，Node 不再保留 standalone DDL fallback。

该阶段涉及真实用户数据，操作前必须备份，不得用静默覆盖完成迁移。

### 阶段 5：迁移并收缩 Agent，拆分 Python API

- Agent 只保留对话 loop、Skill、Tool adapter、会话和 Presentation；
- 移除 Agent 对 SQLite、FIT 文件和 Provider 的直接所有权；
- 将 FastAPI 按 activities、routes、athlete、strava、agent、narration 拆 router；
- 稳定 Agent route DTO、`request_id`、revision 冲突与 stale response 规则；
- 长任务使用 job + polling/SSE + cancel，避免阻塞基础 API。

### 阶段 6：按纵向切片把 Node 业务 API 迁到 Python

- 依次迁移 route library、activity CRUD、Rider session/FIT 上传、profile、Strava、Agent/narration；
- 每组先建立新旧响应对照测试，再让 Node 保持原 URL 做薄代理，最后删除对应 Node store；
- “确认 route candidate 并物化 SavedRoute”等跨表操作由 Python 单事务完成；
- 完成标准是生产 Node 不再 import `node:sqlite`，不负责 schema 判断，也没有后台业务规则。

### 阶段 7：FastAPI 接管正式 Rider 入口

- Python 复刻并测试当前 Origin、Host、认证、OAuth state、受管文件路径和上传限制；
- FastAPI 托管唯一 Rider `index.html`、`/src/*`、vendor 资源和全部 `/api/*`；
- 对外继续监听 `:8787`，浏览器 Adapter 和 OAuth URL 不做大爆炸修改；
- 删除 Node BFF、内部 Python Token 和 `:8000` 进程协调；
- `npm start` 继续作为开发入口，但最终只启动一个 Python Backend。

### 阶段 8：部署、桌面打包与兼容债清理

- 建立单一 `RIDER_DATA_ROOT`，支持仓库、本机服务、Docker 和桌面用户数据目录；
- 锁定 Python 依赖并分别构建各平台 Backend；
- Electron 只负责窗口、Web Bluetooth 权限、OAuth 外部浏览器和 Python sidecar 生命周期；
- 清理旧环境变量、兼容 re-export、不可达 Tool 和 `services/training-agent` 空目录；
- 大文件最后按业务能力拆分，不按行数机械切割。

## 14. 兼容策略

纯结构迁移期间必须保持：

- Rider 当前使用的 HTTP URL 不变；
- `agent_turn.v1`、`presentation.v1`、`activity_detail.v1` 不变；
- `route_plan_view.v1` 作为新增领域视图引入，不能通过破坏 `presentation.v1` 偷渡；
- `saved_route.v1` 作为浏览器运行时路线与持久化模型之间的稳定边界；
- 数据库 `user_version=9` 不变；
- `route_plan.v1` 不随 provider 移动改变；
- 原始 FIT 路径继续可读；
- 目录移动与 schema 升级分开提交；
- 旧环境变量至少兼容一个版本；
- Token 和数据库只做显式迁移；
- 临时 re-export 必须写明调用方迁完后的删除条件。
- Node 代理切换与 Python API 实现分开提交；同一提交不能同时删除旧实现和改变响应语义；
- FastAPI 接管 `:8787` 前，必须通过 Node 当前安全、OAuth、上传和静态资源行为的等价回归。

`request_id`、`expected_revision`、response model 和新错误码应先以兼容字段加入；旧消费者迁完并有
契约回归后才能收紧为必填。若持久化 owner 迁移确实需要升级 `user_version`，必须作为独立数据库
migration 提交，包含备份、旧数据 fixture、升级验证和回滚说明。

## 15. 验收要求

每个阶段至少运行：

```bash
git status --short
npm test
npm run test:agent
npm run test:integration
npm run db:check
```

迁移到根 `src` 后，命令名称保持不变，内部 `PYTHONPATH` 和 pytest 目录再随迁移提交调整；不得要求
使用者在新旧目录之间手工切换工作目录。

Python 定向检查：

```bash
cd services/training-agent
python -m pytest -q tests/test_architecture.py
python -m pytest -q tests/test_api.py
python -m pytest -q \
  tests/test_fit_parser.py \
  tests/test_activity_ingestion.py \
  tests/test_activity_facts.py
python -m pytest -q \
  tests/test_single_day_route_plan.py \
  tests/test_segment_aware_route_plan.py \
  tests/test_popular_loop_route.py
```

静态边界：

```bash
rg -n '^from demo|^import demo' services/training-agent
rg -n 'Path\("(data|log|garmin_cn_fit_files)' services/training-agent
rg -n 'personal-fit-agent|Personal FIT Agent|PERSONAL_FIT_AGENT' \
  services/training-agent src scripts docs README.md
```

数据库 migration 必须在临时数据库验证：

```bash
RIDER_TRACKER_DB_PATH=/tmp/rider-structure-audit.db npm run db:init
RIDER_TRACKER_DB_PATH=/tmp/rider-structure-audit.db npm run db:check
```

每个阶段还需手工检查：

- 首页 Agent 能分析最新活动；
- FIT 导入后能打开结构化详情；
- Garmin 指定数量同步；
- Strava OAuth、上传和状态轮询；
- AI 路线生成、选择、修改、确认和保存；
- 街景讲解准备与显示；
- 重启后活动、路线、Workflow 和 Token 从根数据目录恢复；
- Python 未启动或运行中崩溃时，基础 Rider 页面、GPX、设备、ERG 和实时骑行仍可用。

跨进程自动化至少补充：

- FIT upload -> Python ingestion -> activity detail；
- route plan fixture -> select/confirm -> `saved_route_id` -> reload；
- 同一个 route command `request_id` 重放只执行一次；
- `expected_revision` 冲突返回 409，不覆盖新计划；
- 同一 turn 出现多个 plan 时 Browser fail-closed；
- Agent timeout/unavailable 返回稳定错误且不停止 Rider；
- 数据库 migration 后 Node/Python 都只检查预期版本。

## 16. 推荐最近执行顺序

建议接下来依次处理：

1. 完成阶段 0 剩余 contract fixture、OpenAPI snapshot 和真实双进程失败场景。
2. 在根 `src` 建立 Python package/测试/启动骨架，先迁 contracts、配置与 runtime paths。
3. 迁移 FIT、Activity、Athlete、Route planning domain，并把生产 Provider 从 Demo 提升出来。
4. 将 `services`/`operations` 收敛为 application use case，再收缩 Agent 和拆 FastAPI routers。
5. 按 route library、activity、FIT、profile、Strava、Agent 的顺序迁移 Node API owner。
6. Python 成为唯一持久化 owner 后，删除 Node stores 和 standalone DDL。
7. FastAPI 完成安全与 OAuth 等价验收后接管 `:8787` 和正式 Rider 页面。
8. 最后删除 Node 生产后端与旧服务目录，再做依赖锁、桌面 sidecar 和大文件拆分。

最终完成标准不是“所有代码使用同一种语言”，而是 Browser JavaScript 与 Python Backend 之间只有
一组稳定接口，后台业务、事务、运行时路径和部署入口都只有一个 owner。
