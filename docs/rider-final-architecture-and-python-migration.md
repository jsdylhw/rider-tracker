# Rider 最终架构与 Python 后端迁移总结

> 状态：当前唯一权威架构与迁移计划
>
> 更新日期：2026-08-26
>
> 适用范围：Rider Tracker 浏览器前端、Rider Node 服务、内嵌 Python Training Backend

## 1. 最终结论

Rider 的迁移应采用两段式目标，不能把迁移期架构和最终架构混为一谈。

### 1.1 迁移期目标

```text
Browser JavaScript
        |
        | 同源 /api/*
        v
Thin Node BFF / Local Gateway :8787
        |
        | 内部 HTTP
        v
Python Rider Training Backend :8000
        |
        v
SQLite / FIT / 外部服务
```

迁移期保留 Node，用它稳定浏览器入口和现有 `/api/*`，同时逐步把数据库、Agent 和后台业务迁入
Python。Node 在这一阶段应不断变薄，而不是继续增加业务能力。

### 1.2 理想最终目标

```text
Browser JavaScript
        |
        | 同源 HTTP / SSE
        v
Python Web API :8787
        |
        +--------------------+
        |                    |
        v                    v
Python Worker          SQLite / FIT Files
Agent / LLM / Sync     Token / Workflow
```

最终建议是：

- 浏览器前端继续使用 JavaScript；
- 生产 Web API 和后台业务统一由 Python 承担；
- Python 成为数据库、活动、路线、Agent 和外部工作流的唯一 owner；
- 删除生产环境中的 Node server；
- Node/npm 可以继续作为开发期依赖管理、JavaScript 测试和前端资源打包工具；
- Python Web API 与 Python Worker 保持独立进程，不能因为语言统一又把慢 Agent 任务和基础 API
  放回同一故障域。

因此，“最终删除 Node”准确地指：

> 删除 Node/Express 生产服务，不再要求最终用户为了启动 Rider 安装和运行 Node server。

它不表示把浏览器 JavaScript 改写成 Python，也不一定表示仓库中完全没有 `package.json`、npm 或
JavaScript 测试。

## 2. 当前系统已经融合到什么程度

当前项目不是两个独立产品，而是一个单仓库、双运行时、双进程的本地模块化单体：

```text
Browser -> Rider Node :8787 -> Python Backend :8000

Node 与 Python 当前共用：
- config.yaml
- data/rider-tracker.db
- data/files/fit/
- 启动和停止生命周期
```

已经完成的融合包括：

- Training Agent 已进入 Rider 主仓库；
- 根 `npm start` 统一启动两个进程；
- Rider 是唯一浏览器产品入口；
- Python 遗留独立 Web UI 已在当前开发工作区删除；
- 根 `config.yaml` 是统一人工配置入口；
- SQLite schema 和显式 migration 已由 Python 管理；
- FIT 历史解析已经以 Python 为权威实现；
- Garmin、Strava、Agent、路线规划和路线讲解主要位于 Python；
- Rider 浏览器只通过 Node 同源 API 访问 Python，不接触 Python 内部 Token。

尚未完成的融合主要不是“代码是否在同一仓库”，而是：

- Node 与 Python 仍共同写 SQLite；
- Agent 路线仍通过通用 Presentation 隐式传递领域数据；
- Python route plan 确认与 Rider saved route 保存不是同一事务；
- Agent 是 Rider 启动和存活的硬依赖；
- 长任务仍使用长时间同步 HTTP；
- 正式 Python 路线代码仍依赖部分 `demo/` provider；
- 真实双进程测试目前主要覆盖 health proxy，而非完整业务链路。

## 3. 为什么浏览器实时骑行继续保留 JavaScript

以下能力天然属于浏览器和 JavaScript，不应该为了“统一语言”迁入 Python：

- Web Bluetooth 设备发现和连接；
- FTMS control point、ERG、坡度和阻力命令；
- 心率带、功率计和骑行台实时采样；
- 约 200-1000ms 周期的骑行物理更新；
- 页面状态、地图、街景、图表和 PiP；
- 当前骑行的 runtime route 和不可变 session snapshot；
- 设备断线、命令确认和浏览器生命周期处理。

这些能力迁到服务端会增加网络延迟和故障点，并且仍然需要浏览器 JavaScript 调用设备 API。最终
架构的目标不是单语言，而是让每类代码位于最合适的运行环境。

## 4. 为什么后台业务最终统一到 Python

Python 已经承担 Rider 大部分后台业务：

- FIT 解码、确定性指标、特征和活动详情；
- Agent、Skill、Tool、Presentation 和 LLM；
- Garmin 同步和活动工作流；
- Strava Token、OAuth exchange、上传和状态；
- 国内外路线规划、Strava 路段和路线讲解；
- SQLite schema、repository、workflow 和 chat session；
- CLI、评测和后台任务。

让 Python 成为唯一后台 owner 可以解决：

- Node/Python 双数据库 writer；
- 两边重复的 DTO 校验和 schema 假设；
- 路线确认与保存无法形成一致性操作；
- database migration owner 与 repository owner 分裂；
- 远程部署或容器化时依赖共享文件路径；
- 同一业务规则在 JS server 和 Python 中重复演进。

Python 统一后台以后，Node BFF 在迁移末期只剩静态资源、代理、Origin、安全、上传和 OAuth callback。
FastAPI/Starlette 可以承担这些能力，因此在所有迁移门槛满足后，继续保留生产 Node server 的收益
会很有限。

## 5. 为什么不能现在直接重写 Node

整体重写会同时改变：

- 浏览器入口和静态资源提供方式；
- 活动、路线、运动员和 Strava API；
- FIT multipart upload 与受管文件路径；
- OAuth state 和 callback 页面；
- Origin、Host、Token 和 loopback 安全边界；
- 数据库 writer 和事务；
- Windows 启动、依赖安装和发布方式；
- JavaScript、Python 和双进程测试。

这些变化同时发生时，很难判断错误来自语言迁移、契约变化、数据库迁移还是安全边界变化。正确
方式是 Strangler Migration：

1. 保持浏览器 URL 不变；
2. 先让 Node route 转发到 Python；
3. 用契约和双实现回归验证结果；
4. 再删除对应 Node store 和业务实现；
5. 当 Node 只剩纯网关后，由 Python 接管 `:8787`；
6. 最后删除 Node 生产服务。

## 6. 最终运行时职责

| 能力 | 最终 owner | 说明 |
|---|---|---|
| UI、地图、街景、图表、PiP | Browser JavaScript | 不进入 Python |
| Web Bluetooth、FTMS、设备状态 | Browser JavaScript | 保持本地实时控制 |
| 骑行物理、readiness、trainer command | Browser JavaScript Domain | 不复制到 Python |
| Runtime Route、Ride Session | Browser JavaScript | 从稳定 SavedRoute 创建快照 |
| 静态资源和 `/api/*` | Python Web API | 最终监听 `:8787` |
| Origin、Host、认证、OAuth state | Python Web API | 等价替换 Node 安全边界 |
| FIT 上传和受管文件路径 | Python Web API/Application | 只允许明确数据目录 |
| Activities、Saved Routes、Progress | Python Application/Repository | Python 唯一持久化 owner |
| FIT 历史解析与活动分析 | Python Application/Worker | 原始 FIT 是事实源 |
| Agent、LLM、路线规划和讲解 | Python Worker | 与基础 Web API 隔离 |
| Garmin、Strava 和地图 provider | Python Infrastructure | 外部副作用集中管理 |
| SQLite schema 和 migration | Python Persistence | Node 不再读写数据库 |
| 跨边界数据格式 | OpenAPI / JSON Schema | 不依赖 Presentation 猜领域数据 |

## 7. 最终进程模型

后端统一 Python 不代表只运行一个 Python 进程。

### 7.1 Python Web API

负责短请求和基础可用性：

- 静态前端资源；
- health、readiness 和 capability 状态；
- 活动与路线 CRUD；
- 运动员档案；
- FIT 文件接收；
- OAuth callback；
- 创建、查询和取消 job；
- SSE 或轮询状态输出。

Web API 不应直接执行 30-240 秒的模型、同步或复杂路线任务。

### 7.2 Python Worker

负责耗时或有外部副作用的任务：

- Agent turn；
- LLM 活动分析；
- FIT artifact 重建；
- Garmin 同步；
- Strava 上传；
- 复杂路线发现和路段组合；
- 批量报告和可恢复 workflow。

Worker 崩溃或模型不可用时，Web API、历史活动、GPX、设备和实时骑行必须继续可用。

### 7.3 本地持久化

本地单用户版本继续使用：

```text
data/
├── rider-tracker.db
├── files/
│   └── fit/
├── credentials/
├── workflows/
├── cache/
└── logs/
```

SQLite 适合当前本地产品，但需要：

- Python 是唯一代码 owner；
- 显式 migration；
- WAL、busy timeout 和短事务；
- 长任务不得长期持有写事务；
- migration 前备份；
- 所有运行时路径从 Rider 根目录或安装数据目录统一解析。

如果未来变成多用户云服务，再单独评估 PostgreSQL 和对象存储；这不是本轮融合的前置条件。

## 8. 最终项目目录建议

```text
rider-tracker/
├── apps/
│   └── rider-web/
│       ├── index.html
│       ├── package.json
│       └── src/
│           ├── domain/
│           │   ├── ride/
│           │   ├── route/
│           │   ├── workout/
│           │   ├── physics/
│           │   └── metrics/
│           ├── app/
│           │   ├── services/
│           │   ├── store/
│           │   └── realtime/
│           ├── adapters/
│           │   ├── api/
│           │   ├── bluetooth/
│           │   ├── maps/
│           │   └── export/
│           └── ui/
│
├── services/
│   └── rider-backend/
│       ├── pyproject.toml
│       ├── rider_backend/
│       │   ├── api/
│       │   │   ├── main.py
│       │   │   ├── middleware/
│       │   │   ├── models/
│       │   │   └── routes/
│       │   │       ├── activities.py
│       │   │       ├── routes.py
│       │   │       ├── athlete.py
│       │   │       ├── agent.py
│       │   │       ├── strava.py
│       │   │       ├── narration.py
│       │   │       └── jobs.py
│       │   ├── application/
│       │   │   ├── activities/
│       │   │   ├── routes/
│       │   │   ├── athlete/
│       │   │   ├── narration/
│       │   │   └── jobs/
│       │   ├── domain/
│       │   │   ├── activity/
│       │   │   ├── route/
│       │   │   ├── athlete/
│       │   │   └── contracts/
│       │   ├── agent/
│       │   │   ├── main/
│       │   │   ├── analysis/
│       │   │   ├── narration/
│       │   │   ├── skills/
│       │   │   ├── tools/
│       │   │   └── runtime/
│       │   ├── infrastructure/
│       │   │   ├── fit/
│       │   │   ├── persistence/
│       │   │   │   ├── migrations/
│       │   │   │   └── repositories/
│       │   │   └── providers/
│       │   │       ├── garmin/
│       │   │       ├── strava/
│       │   │       ├── amap/
│       │   │       ├── google/
│       │   │       └── llm/
│       │   └── worker/
│       │       ├── main.py
│       │       └── handlers/
│       └── tests/
│
├── contracts/
│   ├── openapi.json
│   └── fixtures/
│       ├── agent-turn/
│       ├── activity-detail/
│       ├── route-plan/
│       └── saved-route/
│
├── tests/
│   ├── e2e/
│   ├── fit/
│   └── gpx/
├── scripts/
├── config.yaml.example
└── data/
```

目录重命名不是早期目标。应先稳定 owner、契约和启动方式，再使用独立提交迁移 namespace 和物理
路径。

## 9. Node 在不同阶段的定位

| 阶段 | Node 的角色 | 是否生产运行 |
|---|---|---|
| 当前 | 页面、BFF、上传、OAuth、SQLite、Python 代理 | 是 |
| 迁移中期 | 静态资源、安全、上传、OAuth、纯代理 | 是 |
| Python 接管边缘入口后 | 仅作为切换前兼容入口 | 临时 |
| 最终 | npm、JS 测试、前端资源构建 | 否 |

最终删除的是：

- Express 生产服务；
- Node activity/route SQLite store；
- Node 到 Python 的机械代理；
- Node 生产启动和健康管理；
- 最终用户对 Node runtime 的启动依赖。

可能继续保留的是：

- `package.json` 和 lockfile；
- JavaScript 单元测试；
- 前端 lint/build/vendor copy；
- 开发环境中的 npm scripts。

## 10. 跨进程和前后端契约

### 10.1 契约原则

- 只有跨 HTTP、缓存、持久化和重放的数据才定义稳定版本；
- Pydantic response model 是 Python API 的权威定义；
- OpenAPI/JSON Schema 用于生成或校验 Browser DTO；
- Presentation 只表达展示，不作为路线和活动领域 API；
- 删除字段、改变单位或语义必须升级主版本；
- 新字段优先兼容性增加，消费者迁完后再改为必填；
- 所有错误、job 和可重放命令携带 `request_id`。

### 10.2 Route Plan View

Rider 不应再从 `table + route_map` 猜路线计划。推荐公开：

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
    geometry              # WGS84 GeoJSON LineString [lng, lat]
    waypoints[]
    segment_overlays[]
```

路线 command 必须携带：

- `request_id`：幂等重放；
- `expected_revision`：乐观并发；
- `plan_id`；
- `candidate_id`；
- allowlisted operation。

revision 不匹配应返回 409，不能静默覆盖。

### 10.3 Saved Route

```text
saved_route.v1
  saved_route_id
  source
  name
  geometry
  total_distance_m
  elevation_status
  agent_plan_id
  agent_candidate_id
  metadata
```

Python 保存 provider 无关的路线资产。Browser JavaScript 根据 SavedRoute 创建 runtime snapshot，
继续负责虚拟 `25 km/h` 时间估算、无海拔按平路处理和实时路线推进，Python 不复制这些实时规则。

### 10.4 Error Envelope

```text
error.v1
  request_id
  code
  message
  retryable
  details
```

至少区分：

- `validation_error`；
- `revision_conflict`；
- `agent_unavailable`；
- `provider_unavailable`；
- `job_failed`；
- `not_found`；
- `unauthorized`。

响应不能向浏览器泄露 Token、内部 FIT 绝对路径、工具原始输入或模型内部状态。

### 10.5 Job Contract

```text
job.v1
  job_id
  job_type
  status
  progress
  result_ref
  error
  created_at
  updated_at
```

建议状态：`queued / running / succeeded / failed / cancelled`。重启后需要恢复的任务写入 SQLite；短暂
的只读 Agent turn 是否持久化可按具体用例决定。

## 11. 当前最高优先级风险

### 11.1 Node/Python 双写 SQLite

当前 Node 写 activities、saved routes 和 progress，Python 写活动事实、报告、计划和会话。问题不是
当前吞吐量，而是：

- 跨进程操作不能组成一个事务；
- 两边可能绕过对方 repository 不变量；
- schema owner 和业务 owner 不一致；
- 远程或容器部署依赖共享 SQLite 和文件路径。

目标：所有数据库读写进入 Python repository，Browser API URL 保持不变。

### 11.2 Agent 路线把 Presentation 当领域 API

当前 JS 会收集一轮中的 route maps、展平路线并按 candidate ID/名称拼接。如果同一 turn 有多个
execution 或 plan，可能混合不同计划的状态和几何。

目标：Browser 只消费 `route_plan_view.v1`；Presentation 继续用于通用 UI 展示。

### 11.3 路线确认存在 fail-open

确认响应返回后，必须同时验证：

- `planning_status == confirmed`；
- response revision 等于预期 revision；
- requested、active、confirmed candidate 一致；
- 返回几何通过 schema 和资源上限检查。

任一条件不满足都必须保持 draft，不能解锁骑行。

### 11.4 路线确认与保存不是一致性操作

最终应由 Python application 在一个明确用例中完成：

```text
确认 RoutePlan candidate
  -> 校验 revision 和 workspace
  -> 物化 SavedRoute
  -> 提交事务
  -> 返回 saved_route_id
```

如果某阶段仍跨服务，至少需要 operation ID、可重试 saga 状态和补偿，不能吞掉保存错误。

### 11.5 Agent 是 Rider 的硬依赖

当前 Agent 未健康时 Rider 无法正常启动，任一子进程退出又会停止全部服务。

目标：

- 基础 Web API 和前端始终启动；
- Agent/路线/分析功能明确显示降级；
- 对相应 API 返回 `503 agent_unavailable`；
- GPX、设备、ERG、模拟和实时骑行继续工作；
- Worker 可以独立重启。

### 11.6 长任务使用长连接

普通 FastAPI `def` handler 会进入线程池，因此风险不应简单描述为“单个同步 handler 必然阻塞整个
event loop”。真正问题是：

- 长时间占用 worker/thread；
- 无进度；
- 无取消；
- 客户端 240 秒超时；
- 进程退出后难以恢复。

目标：慢任务采用 job + polling/SSE + cancel。

### 11.7 正式代码依赖 Demo

高德、Google 和 Strava Segment 的生产实现应迁入正式 infrastructure provider。最终依赖方向是：

```text
demo/experiments -> 正式 provider/domain
application      -> 正式 provider/domain
```

禁止正式 application/service 反向 import `demo`。

### 11.8 路径、命名和依赖漂移

- 所有运行时路径应从统一项目/安装数据根目录解析；
- Token 冲突必须显式迁移，不能静默覆盖；
- 产品名、Python namespace、环境变量和数据库名逐步统一；
- `pyproject.toml` 成为 Python 依赖声明源并生成可复现锁文件；
- namespace、schema、URL 和物理目录改名不得放在同一提交。

## 12. 迁移原则

1. **契约先于实现迁移**：先固定 request/response，再切换 owner。
2. **保持浏览器 URL**：迁移期间继续使用现有 `/api/*`。
3. **一次迁移一个纵向用例**：例如先迁 saved route，再迁 activities。
4. **同一业务只有一个权威 owner**：切换后删除旧实现，不长期双写。
5. **数据库 migration 独立提交**：包含备份、fixture、升级和回滚说明。
6. **故障隔离先于长任务扩张**：Agent 不得拖垮基础 Rider。
7. **运行规则不跨语言复制**：实时骑行规则留在 JS，后台事实留在 Python。
8. **不做大爆炸重写**：Node 最后删除，不是第一步删除。
9. **以发布结果验收**：最终用户确实不需要 Node runtime 才算完成。

## 13. 分阶段执行计划

### 阶段 0：冻结决策和基线

- 建立本架构 ADR；
- 固定当前 Browser API surface；
- 保存 OpenAPI 和关键 JSON fixture；
- 统一错误 envelope、request ID 和日志关联规则；
- 记录当前 JS、Python 和双进程测试基线；
- 本阶段不移动生产代码。

### 阶段 1：完成当前遗留 Web UI 删除验收

- 检视当前删除 diff；
- 运行 Python 全量回归；
- 运行真实双进程集成；
- 浏览器验收 Garmin、FIT、报告、Agent、路线和 Strava；
- 独立提交，不同时修改 namespace、schema 和公开 URL。

### 阶段 2：稳定路线契约和异步安全

- 增加 `route_plan_view.v1`；
- candidate 使用稳定 ID，不再按名称 join；
- route command 增加 request ID 和 expected revision；
- confirm 改为 fail-closed；
- 所有 command 增加 stale response 和骑行开始后二次检查；
- 拒绝不支持的 multi-day/stage，而不是静默连接；
- 抽出 provider 无关的 JS `buildCoordinateRoute()`；
- 补多 execution、多 plan、重放和并发测试。

### 阶段 3：让 Agent 可降级

- Rider 基础入口不再等待 Agent 健康；
- Worker 异常不停止基础 Web 服务；
- 增加 `503 agent_unavailable`；
- UI 显示能力级降级；
- 自动验证无 Agent 时 GPX、设备、ERG 和实时骑行。

### 阶段 4：统一运行时路径和 schema owner

- 引入统一 runtime path resolver；
- 修复 Token、workflow、log、evaluation artifact 路径；
- 显式迁移子目录旧数据；
- 删除 Node standalone DDL；
- Python migration 成为唯一 schema owner。

### 阶段 5：让 Python 成为唯一持久化 owner

建议顺序：

1. `saved_routes` / `route_progress`；
2. route confirm + SavedRoute 事务；
3. activities list/detail/rename/delete；
4. Rider session archive；
5. FIT metadata 和 ingestion；
6. athlete profile 的剩余本地兼容字段。

每个切片都采用：Python API -> Node 代理 -> 对照测试 -> 切换 -> 删除 Node store。

阶段完成标准：生产 Node 不再 import `node:sqlite`，也不负责数据库初始化、版本判断或业务事务。

### 阶段 6：正式化 provider 和长任务

- 将生产使用的高德、Google 和 Strava Segment 代码移出 `demo/`；
- 增加禁止生产代码 import demo 的架构测试；
- Agent、同步、报告和复杂路线进入 job/worker；
- 增加 polling/SSE/cancel；
- 加入结构化观测和可复现 Python 依赖锁。

### 阶段 7：实现 Python 边缘 Web API

在 Node 仍然提供正式入口时，让 Python 逐项具备：

- 静态前端资源；
- Browser `/api/*` 完整 surface；
- Origin、Host、loopback/token middleware；
- multipart upload 和受管路径；
- OAuth state/callback/result；
- health/readiness/capability；
- 前端 fallback 和缓存策略。

这一阶段使用相同契约测试同时验证 Node 入口和 Python 入口。

### 阶段 8：切换 `:8787` 到 Python

- Python Web API 成为默认启动入口；
- Node BFF 保留为临时兼容启动选项；
- 对比两个入口的契约、安全、性能和浏览器行为；
- Windows 和其他发布方式验证无需 Node server；
- 观察一个明确兼容周期。

### 阶段 9：删除生产 Node server

满足第 14 节门槛后：

- 删除 Express server 和 Node proxy routes；
- 删除 Node activity/route stores；
- 删除 Node 生产启动编排；
- 清理只为 Node server 存在的依赖和测试；
- 保留前端开发、测试和构建所需的最小 Node/npm 工具链；
- 更新 README、Windows 启动和发布文档。

### 阶段 10：namespace 和目录整理

- 引入 `rider_backend` namespace；
- 按 application/domain/infrastructure/api/worker 整理 Python；
- 删除兼容 re-export、不可达 Tool 和 operation facade；
- 最后再进行物理目录改名和大文件拆分；
- 不与生产 Node 删除、数据库 migration 放在同一提交。

## 14. 删除 Node server 的强制门槛

以下条件必须全部满足：

1. Node 已经不访问 SQLite，也没有后台领域逻辑；
2. Python 覆盖 Browser 所有正式 `/api/*`；
3. Python 等价实现 Origin、Host、认证、OAuth state 和受管文件路径保护；
4. Python Web API 与 Agent/Worker 已隔离；
5. Worker 不可用时基础 Rider 仍可启动和骑行；
6. FIT、活动、路线、Strava、Agent 和 narration 都有端到端回归；
7. route command 幂等、revision conflict 和 fail-closed 已验证；
8. 数据库 migration、备份和旧用户数据升级已验证；
9. 前端静态资源和 `@garmin/fitsdk` 等生产资产不依赖运行中的 Node；
10. Windows 发布包或统一启动方式证明最终用户无需 Node runtime；
11. Python 入口经过至少一个兼容观察周期；
12. 回滚到上一稳定入口的步骤清楚且已演练。

任一门槛未满足，都应继续保留薄 Node BFF，不得为了形式上的“全 Python”提前删除。

## 15. 测试与验收矩阵

### 15.1 JavaScript

- 骑行物理、readiness 和 trainer command；
- Bluetooth/FTMS adapter；
- Route DTO -> runtime route；
- stale response 和骑行中路线锁；
- UI、地图、街景和 PiP；
- 无 Agent 降级状态。

### 15.2 Python

- API request/response model；
- activity、route、athlete repository；
- FIT ingestion/detail/artifact；
- route plan revision 和 confirm transaction；
- job state machine、恢复和取消；
- provider adapter；
- security middleware；
- 架构依赖方向。

### 15.3 Contract

- OpenAPI snapshot；
- `agent_turn.v1`；
- `presentation.v1`；
- `activity_detail.v1`；
- `route_plan_view.v1`；
- `saved_route.v1`；
- `error.v1`；
- `job.v1`。

### 15.4 双进程/端到端

- FIT upload -> ingestion -> detail；
- route plan -> select/confirm -> saved route -> reload；
- 同 request ID 重放只执行一次；
- expected revision 冲突返回 409；
- Agent timeout/unavailable 不停止 Rider；
- Worker 重启后恢复持久化 job；
- Strava OAuth、上传和状态轮询；
- migration 后旧活动和路线仍可读取。

### 15.5 安全

- 非法 Origin 和 Host；
- 无 Origin 的非浏览器请求；
- loopback 与 LAN 行为；
- Token 缺失和错误；
- OAuth state 过期、重放和不匹配；
- FIT 路径穿越和目录外文件；
- 上传大小和 JSON/geometry 资源上限；
- response 不泄露 Token、绝对路径和内部 Agent 数据。

### 15.6 发布

- 新机器首次安装；
- Windows 一键启动；
- Python Web API 与 Worker 独立 readiness；
- 不安装 Node runtime 也能启动生产 Rider；
- 浏览器能加载全部静态/vendor 资源；
- 备份、升级和回滚数据库。

## 16. 非目标

本轮最终架构不要求：

- 把浏览器前端改成 Python；
- 把实时 FTMS 控制移到后端；
- 为了目录整齐引入大量微服务；
- 立即替换原生 ES Modules 或前端框架；
- 立即将 SQLite 改为 PostgreSQL；
- 在契约稳定前重写全部页面；
- 同时改 namespace、URL、schema 和物理目录；
- 为“看起来单语言”牺牲故障隔离。

## 17. 最终完成定义

迁移完成时应满足：

```text
Browser JavaScript
  - UI / Maps / Bluetooth / FTMS
  - Ride Domain / Runtime Route
          |
          v
Python Web API :8787
  - Static / Security / Browser API
  - Activities / Routes / Athlete / OAuth
          |
          +----------------------+
          |                      |
          v                      v
Python Worker               SQLite / Files
  - Agent / FIT / Sync       - Single backend owner
  - Route / Strava / LLM     - Explicit migrations
```

最终验收语句：

> Rider 保留 JavaScript 浏览器实时骑行内核；Python 统一生产后端、数据和后台任务；Node server
> 从生产运行时删除，但可作为前端开发和测试工具继续存在。

## 18. 与现有文档的关系

- [`training-agent-integration.md`](./training-agent-integration.md)：当前 Node/Python 集成和数据边界；
- [`remove-training-agent-legacy-web-ui-plan.md`](./remove-training-agent-legacy-web-ui-plan.md)：旧 Python Web UI 删除实施记录。

本文件是最终目标、目录结构、阶段编号、执行顺序和完成标准的唯一来源。其他文档只记录当前集成
状态或单项实施细节，不得再维护另一套迁移阶段。权威的两段式定义为：

1. 迁移期：薄 Node BFF + Python 主后端；
2. 最终：JavaScript 浏览器前端 + Python Web API/Worker，删除生产 Node server。
