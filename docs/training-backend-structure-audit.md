# Training Backend 结构债审计

## 1. 审计范围

本报告审计 Rider Tracker 内嵌 Python 服务：

```text
services/training-agent/
```

审计快照：

- 分支：`feat/embedded-training-agent`
- 基线提交：`1f8f46d refactor(ride): remove synthetic heart-rate model`
- 审计方式：目录、导入关系、HTTP 消费方、运行时路径、文档和测试的只读检查
- 初次审计本身不执行目录迁移、API 删除、数据库迁移或用户数据移动；补充复核只记录当前工作区结果
- 补充复核日期：2026-08-26；复核基于当前开发工作区，包含尚未提交的旧 Python Web UI 删除结果
- 补充复核时 `npm test` 为 `335 / 335` 通过；当前系统 Python 未安装 `pytest`，因此该次复核不能代替 Python 回归与真实双进程集成验收

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

> 行数用于定位热点，不应作为机械拆文件的依据。表中保留初次审计快照；当前开发工作区已删除
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

### 2.1 关于“Rider 后端是否整体改成 Python”的结论

不建议现在把 Rider Node 后端整体重写为 Python。推荐目标是：

```text
Browser JavaScript
  - UI / 地图 / Web Bluetooth / FTMS
  - 骑行物理、实时状态和 runtime route
          |
          | 同源 /api/*
          v
Rider Node BFF :8787
  - 静态资源、同源入口和本地安全边界
  - Python API Token 隔离
  - 必要的文件接收、OAuth callback 和短代理
          |
          | HTTP + X-API-Token
          v
Rider Training Backend Python :8000
  - Agent / FIT / 活动与路线后台业务
  - Garmin / Strava / 地图 provider / LLM
  - SQLite migration、repository 和长任务
```

这里的收敛方向是“后台业务与持久化逐步 Python 化”，不是一次性删除 Node：

- Web Bluetooth、FTMS 和实时骑行本来就在浏览器，改服务端语言不能减少这部分 JavaScript。
- Node server 只占 Rider JavaScript 的较小部分；即使重写它，浏览器领域代码、JS 测试和
  `@garmin/fitsdk` 工具链仍然存在。
- Node 当前仍提供有价值的浏览器同源入口、Origin 检查和服务端 Token 注入；浏览器不需要知道
  Python 内部 API Token。
- Python 已经承接最适合其生态的 FIT、Agent、分析、路线、Garmin、Strava 和工作流，继续让它
  成为后台业务 owner 比复制这些能力到 JavaScript 更合理。
- 即使未来服务端全部使用 Python，也应把 Web/API 进程与 Agent/长任务 worker 分开，不能因为
  语言统一又把慢模型调用和核心 API 合并到同一故障域。

### 2.2 三种方案比较

| 方案 | 收益 | 主要代价和风险 | 判断 |
|---|---|---|---|
| 保留当前双写结构 | 不迁移、近期风险最低 | Node/Python 共同写 SQLite，契约、DDL 和事务继续漂移 | 只适合作为短期状态 |
| 浏览器 JS + 薄 Node BFF + Python 主后端 | 可逐步迁移，保留同源、安全和进程隔离，后台 owner 清晰 | 仍需维护两个运行时和内部 HTTP | 推荐目标 |
| Node server 全量重写为 Python | 最终可能少一个生产服务进程 | 需重写上传、OAuth、安全、静态/vendor 和回归测试；JS 开发工具链仍在 | 当前收益不足，不推荐立即执行 |

### 2.3 推荐职责 owner

| 能力 | 推荐 owner |
|---|---|
| UI、地图展示、Web Bluetooth、FTMS | Browser JavaScript |
| 骑行物理、readiness、trainer command、runtime route | Rider JavaScript Domain |
| 静态资源、同源入口、Origin/Auth、内部 Token 注入 | 薄 Node BFF |
| FIT 历史解析、Agent、路线规划、路线讲解 | Python Backend |
| Garmin、Strava、LLM、可恢复长任务 | Python Backend |
| SQLite schema、migration、repository 和跨表事务 | Python Backend |
| Python -> Node -> Browser 数据格式 | 版本化 OpenAPI / JSON Schema 契约 |

`Node BFF` 可以长期保留，也可以在满足本报告第 13 节“阶段 9”的退出门槛后被 FastAPI 取代；它不应继续
持有与 Python 重叠的数据库和后台领域实现。

### 2.4 当前结构债优先级

当前最重要的结构债依次是：

1. Agent 路线仍从通用 Presentation 反向拼装领域数据，确认、revision 和异步响应缺少 fail-closed
   契约。
2. Node 与 Python 同时直接写共享 SQLite；Python 虽是 migration owner，但还不是唯一持久化 owner。
3. Agent 当前是 Rider 启动和存活的硬依赖，故障会连基础骑行入口一起停止。
4. 正式路线服务反向依赖 `demo/`，Google/Strava provider 仍有重复实现。
5. Python 服务名称、包名、客户端名、环境变量和数据库名不一致。
6. 运行时相对路径可能在服务源码目录中生成第二份 Token、工作流、日志或数据库。
7. `operations/activity`、`services/activity`、`fit/analysis` 的职责边界仍有兼容门面和反向包装。
8. 过时文档、不可达 Tool 和兼容门面继续增加维护范围。

旧 Python Web UI 的删除已在当前开发工作区完成，优先级从“结构债”转为“代码检视、浏览器手工
验收与提交”。

推荐先修跨进程契约、事务 owner 和故障隔离，再进行大规模 namespace、目录或语言调整。

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

不建议第一步直接创建仓库根目录的松散 Python 包：

```text
rider-tracker/fit/
```

原因：

- Node 与 Python 源码边界会更模糊；
- 当前启动方式依赖 Python 服务 cwd，跨目录 import 会进一步复杂化；
- FIT 导入仍需要运动员档案、活动 repository 和 artifact 持久化，并不是独立进程；
- 当前没有第二个 Python 服务需要直接复用这个包；
- 只移动物理路径不会解决 decoder、纯算法和应用编排混杂的问题。

### 3.3 推荐边界

先把 `services/training-agent` 视为一个 Python Backend，在同一个可安装 namespace 内拆分：

```text
rider_backend/
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

## 4. 双前端（当前开发工作区已完成删除）

### 4.1 初次审计事实

初次审计时 Training Agent 仍维护 `app/static/`、`tests/test_web_ui.py` 和一组只供旧页面消费的
Dashboard、Garmin、FIT、报告与上传 API。它们与 Rider 页面重复渲染 Presentation、路线地图和
Strava 状态，是当时优先级最高、风险最低的删除目标。

### 4.2 当前状态

当前开发工作区已经按
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

建议统一概念：

- 产品：Rider Tracker；
- Python 服务：Rider Training Backend；
- 对话能力：Training Agent；
- Python namespace：`rider_backend`；
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

当前开发工作区已经同步整理主要文档资产：

- `AGENT_STRUCTURE.md` 已描述 `/api/chat`、正式路线服务和 `presentation.v1` 当前链路；
- `README.md` 已明确 Rider 是唯一浏览器入口，Python 只提供 Backend、Agent、CLI 和内部 API；
- `DATABASE.md`、`CLAUDE.md` 已按单仓和共享数据库方向更新；
- 子目录 `.github/workflows/test.yml` 已删除，Python 测试并入根 CI；
- 旧独立服务 `figure.png` 已删除。

以上仍是当前未提交工作区内容，需在合入前检查文档链接、命令和实际代码是否一致。长期仍应把
`CLAUDE.md` 中通用的工程规则迁入仓库统一说明，避免出现另一份只对 Python 子目录有效的产品架构。

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

短期保留物理目录 `services/training-agent`，先引入统一 Python namespace：

```text
services/training-agent/
├── pyproject.toml
├── rider_backend/
│   ├── api/
│   │   ├── main.py
│   │   ├── models.py
│   │   └── routes/
│   │       ├── agent.py
│   │       ├── activities.py
│   │       ├── athlete.py
│   │       ├── strava.py
│   │       ├── route_plans.py
│   │       └── narration.py
│   ├── cli/
│   ├── agent/
│   │   ├── main/
│   │   ├── activity_analysis/
│   │   ├── narration/
│   │   ├── skills/
│   │   ├── tools/
│   │   └── runtime/
│   ├── application/
│   │   ├── activities/
│   │   ├── routes/
│   │   ├── narration/
│   │   └── workflows/
│   ├── domain/
│   │   ├── activity/
│   │   ├── route/
│   │   ├── athlete/
│   │   └── contracts/
│   └── infrastructure/
│       ├── fit/
│       ├── persistence/
│       │   ├── sqlite/
│       │   └── repositories/
│       └── providers/
│           ├── garmin/
│           ├── strava/
│           ├── amap/
│           ├── google/
│           └── llm/
├── tests/
└── evaluation/
```

只有 namespace 和启动方式稳定后，再考虑将物理目录重命名为：

```text
services/rider-backend/
```

不要在同一个提交同时完成物理目录改名、全部 import 改造、API 删除和数据库 migration。

## 13. 分阶段迁移

### 阶段 0：冻结边界并增加护栏

- 合入本报告；
- 用 ADR 固定“Browser JS + 薄 Node BFF + Python Backend”的当前目标；
- 建立 Rider 当前消费的 HTTP request/response contract 测试和 OpenAPI snapshot；
- 统一错误 envelope、schema version、`request_id` 和 correlation header 的规则；
- 增加“生产代码不得 import demo”的架构测试，在 provider 抽取提交中启用；
- 补真实双进程 FIT、路线和 Agent unavailable 测试；
- 本阶段不移动生产代码。

### 阶段 1：完成双前端删除验收

- 详细实施步骤见 [`remove-training-agent-legacy-web-ui-plan.md`](./remove-training-agent-legacy-web-ui-plan.md)；
- 当前开发工作区已完成代码、文档和 CI 整理；
- 运行 Python 全量回归与双进程测试；
- 浏览器手工验收 Garmin、FIT、Agent、路线、报告和 Strava；
- 保持 Rider 所用 API URL 不变；
- 独立提交当前删除，不同时改 namespace、数据库版本和公开 URL。

### 阶段 2：稳定 Agent 路线契约和异步安全

- 增加 `route_plan_view.v1` Pydantic response model，不再从 Presentation table 读取领域数据；
- 给 candidate table/DTO 补稳定 `candidate_id`、plan `revision`、confirmed/active candidate 和
  `schedule_type`；
- JS 检测多个 plan ID、未知版本、未知枚举、非 LineString 和不连续 stage 时 fail-closed；
- route command 增加 `request_id`、`expected_revision` 和 409 conflict；
- confirm 只有在 status/revision/candidate 全部匹配时才能设置 `isDraft=false`；
- 所有 route command 统一使用中央 loading/request ID、骑行后二次检查和 stale response 丢弃；
- 抽出 provider 无关的 `buildCoordinateRoute()`，不再用 `buildMapDrawRoute()` 承载 Agent route；
- 补同 turn 多 execution、多 plan、同名 candidate、重复 undo/reverse 和骑行中晚到响应测试。

### 阶段 3：让 Agent 可降级并补真实跨进程验收

- Node 不等待 Agent 成功才提供 Rider 页面；
- Python 异常退出不再自动结束 Rider，启动器报告独立 readiness 并可重启 Agent；
- BFF 对 Agent 能力返回统一 `503 agent_unavailable`，UI 做能力级降级；
- 验证 Python 不可用时 GPX、设备、ERG、模拟和实时骑行仍可工作；
- 将当前仅验证 health proxy 的双进程测试扩展到 FIT ingest/detail、路线确认保存和超时/重试。

### 阶段 4：统一运行时路径和 schema owner

- 新增统一 `runtime_paths.py`；
- 修复 Strava Token 相对路径；
- Workflow、日志、评测 artifact 统一从 Rider root 推导；
- 只读检查并显式迁移子目录中的旧 Token、数据库和 workflow；
- Node 删除 standalone DDL fallback，Python migration 成为唯一 schema owner。

该阶段涉及真实用户数据，操作前必须备份，不得用静默覆盖完成迁移。

### 阶段 5：让 Python 成为持久化 owner，Node 收缩为 BFF

- Python 增加 `saved_routes` / `route_progress` API 和“确认 candidate 并物化 SavedRoute”事务；
- Node `/api/routes/*` 保持浏览器 URL 不变，逐个改为 Python 代理；
- Python 接管 activities 列表、改名、删除、骑行 session 归档和 FIT metadata；
- Node 可暂时负责受管目录文件接收，但不再直接写活动/路线表；
- 为每个纵向切片先增加双实现对照测试，再切换 owner，最后删除 Node store；
- 完成标准是生产 Node 不再 import `node:sqlite`，也不负责数据库初始化或版本判断。

### 阶段 6：抽取正式地图与 Strava Provider

- 使用 `git mv` 保留历史；
- 将生产使用的高德、Google 和 Strava Segment 代码迁入正式 provider/domain；
- 正式路线服务修改导入；
- Demo 反向调用正式模块；
- 启用禁止生产导入 Demo 的架构测试；
- 保持 route schema 和 HTTP API 不变。

### 阶段 7：长任务、依赖与可观测性

- 对同步、批量分析、复杂路线和报告采用 job + polling/SSE + cancel；
- Browser、Node 和 Python 统一传播 request/session/plan/job ID；
- 记录结构化耗时、重试、revision conflict、provider 和错误类别；
- `pyproject.toml` 作为依赖声明源，生成可复现锁文件，避免与 `requirements.txt` 双维护漂移；
- 明确 Web/API 与 Agent/worker 的资源和故障隔离。

### 阶段 8：清理兼容债并引入 `rider_backend` namespace

- 删除 `generate_route_advice`；
- 审核并删除不可达 conversation tools；
- 拆除 `operations/activity/service.py`；
- 删除 `storage/paths.py`；
- 清理只为旧入口存在的测试和 evaluation 分支。
- 先迁移一个纵向切片，例如 contracts + athlete；
- 短期保留旧模块 re-export，并注明删除条件；
- 再迁移 activity、route、agent、infrastructure；
- 完成所有调用迁移后删除 flat package alias；
- 最后才考虑物理目录改名。
- 在依赖边界稳定后按业务能力拆 repository、route、analysis agent、presentation 和 API，不按
  行数机械拆分。

### 阶段 9：可选——评估是否移除 Node server

只有同时满足以下门槛，才单独编写 ADR 评估由 FastAPI 接管 `:8787`：

1. Node 已不访问 SQLite，也没有 Rider 后台领域逻辑；
2. Python Web/API 与 Agent/worker 已隔离，慢任务不会拖垮基础 API；
3. FIT、路线、Agent、OAuth、安全和降级链路都有真实端到端回归；
4. FastAPI 入口具备当前 Node 的同源、Origin、Host、认证、受管文件路径和 OAuth state 保护；
5. 打包验证证明能真正减少用户侧 Node runtime/安装成本，而不是只替换 2,000 多行 server 实现；
6. 浏览器 `/api/*` 契约和用户数据无需大爆炸迁移。

若满足门槛，也应采用 strangler：先由 Python 接管静态/代理能力，保持 URL 不变，完成回归后再删除
Node；不得与数据库 schema、namespace 或前端框架重写同时进行。

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

1. 检视、完整验收并提交当前 Training Agent 遗留 Web UI 删除。
2. 修复 Agent route 的版本化领域 DTO、确认 fail-closed、幂等和 revision 并发控制。
3. 让 Agent 故障可降级，补 FIT/路线/不可用场景的真实双进程测试。
4. 修正 Strava Token、Workflow、日志和数据库默认路径，删除 Node standalone DDL。
5. 将 activities、saved routes 和 progress 逐步迁入 Python repository/API，使 Node 成为薄 BFF。
6. 把正式路线依赖的 Demo provider 移入正式目录。
7. 再处理长任务、依赖锁、不可达 Tool、operation facade 和 `rider_backend` namespace。
8. 最后才根据明确退出门槛评估移除 Node、拆大文件和物理目录改名。

FIT 不应作为一个独立进程直接搬到仓库外层。真正需要做的是承认当前 Python 服务已经是
Rider Backend，并在这个边界内把 FIT I/O、确定性活动算法和应用编排拆清。语言统一不是目标；
单一事实源、稳定契约、可恢复事务和清晰故障域才是融合完成的标准。
