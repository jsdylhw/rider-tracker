# Rider Tracker 开发与排障指南

本文面向第一次接手仓库的开发者和编码 Agent，目标是让一次问题定位或功能修改可以从稳定入口开始，
而不需要先通读全部历史。最终架构和阶段完成门槛以
[`rider-final-architecture-and-python-migration.md`](rider-final-architecture-and-python-migration.md) 为准；
迁移的实际落地状态以 [`adr/0001-python-backend-consolidation.md`](adr/0001-python-backend-consolidation.md)
和当前 Git 工作区为准。

## 1. 五分钟建立上下文

在仓库根目录执行：

```bash
pwd
git branch --show-current
git status --short
git log -5 --oneline
npm test
```

然后按任务选择阅读路径：

- 浏览器交互或样式：`index.html`、`src/ui`、`src/styles`、`docs/frontend-architecture.md`。
- 骑行状态、readiness 或设备控制：`src/domain/ride`、`src/domain/workout`、`src/app/realtime`。
- 路线导入、编辑或开始骑行：`src/domain/route`、`src/app/services`、`src/adapters`。
- Node Browser API：`src/server/index.js`、`src/server/routes`、`tests/contracts/rider-browser-http-api.v1.json`。
- Python API 或持久化：`services/training-agent/app/api.py`、`storage/repositories`、`storage/database.py`。
- Agent 行为：`agent/main_agent`、`agent/skills`、`agent/tools`；先读对应 Skill，再改 Tool 或 Service。
- 外部平台：`services/training-agent/integrations`；正式代码不得依赖 `demos/`。

不要读取或打印真实 `config.yaml`、`data/credentials`、FIT 或聊天日志来建立普通代码上下文。

## 2. 当前进程和 owner

默认 `npm start` 由 Node 包装 Python 统一启动器：

```text
Browser -> Python Web :8787 -> services / repositories / SQLite / FIT
                  |-> private Agent process (synchronous execution)
                  +-> persisted jobs -> Python Worker
```

`npm run start:legacy` 保留旧 Node BFF :8787 → Python API :8000 回退路径；两套入口不要同时运行。

当前职责原则：

| 能力 | 权威 owner | 注意事项 |
| --- | --- | --- |
| DOM、地图/街景、Web Bluetooth | Browser JS | 不迁入 Python |
| 实时物理、readiness、控制命令 | `src/domain` / `src/app/realtime` | UI 不复制判断 |
| Browser 同源入口 | Python Web | Node 仅作默认启动包装；旧 BFF 以 start:legacy 保留 |
| 活动、路线和用户档案数据 | Python repository | Node 不应重新引入 SQLite DDL 或业务事务 |
| Agent、路线规划、讲解 | Python | Tool 保持薄，确定性规则进入 service/domain |
| Garmin、Strava、AMap、Google、LLM | Python integrations | 网络失败与业务校验失败分开处理 |
| 已任务化的长任务 | Python Worker/Job store | 当前覆盖报告重建和路线讲解；基础骑行不能因 Worker/模型不可用而停止 |

主 Agent 对话、AI 路线规划及 Garmin/Strava 工作流当前仍有同步执行路径。不要仅因为 Worker 进程存在就
假设所有模型和网络调用都已任务化；是否继续迁移应按独立切片决定。

### 当前迁移检查点

- 阶段 0-5 已完成主要架构基线、遗留 UI 删除、路线安全、能力降级、路径/schema owner 和 Python
  持久化 owner 收敛；具体切片以 ADR 为准。
- 阶段 6 已完成正式 Provider 与 `demos/` 解耦，并把报告重建、路线讲解接入持久化任务；其余同步
  工作流暂不为追求形式统一而强制迁移。
- 当前重构方向是阶段 7：让 Python 分批实现 Browser API、安全、上传、OAuth 和静态资源等价能力。
  默认入口已按用户决定切到 Python `:8787`，真实骑行与兼容观察仍待完成。
- 阶段 7B 提供可选 `npm run start:browser-preview` 静态入口，默认 Python :8000；复用同一 Rider 页面，
  这是早期同进程预览入口；当前默认使用独立 Agent 进程。48 项 Browser API 清单和未接通功能见 [入口迁移清单](python-browser-entry-checklist.md)。
- FIT multipart 三入口已由 Python 接收并保存，Node 仅转发；单文件 32 MiB，需安装 `python-multipart`。
  默认启动包装已切换，完整浏览器业务验收仍在推进。
- `python scripts/start-rider.py` 提供无 Node 启动器的隔离预览：Browser Web 处理基础业务，
  `app.agent_process` 复用原同步 Agent HTTP 执行，Worker 继续处理已有任务。`app.agent_proxy` 只转发，
  不重试或重放；内部端口/令牌由启动器生成。Agent 退出时基础 API 保持可用；这不是新增持久恢复。
  发布和回退见 [运行说明](python-release-runbook.md)。不要同时运行两套入口处理同一会话。
- 默认端口已切换，先观察兼容，旧 Node 继续保留；阶段 10 才进行 Python namespace 和大规模目录整理。

本节只提供导航，不替代实时状态。开始任务时必须查看 `git status` 和 ADR 尾部；工作区中的实现可能尚未
形成提交，不能直接当成已交付能力。

## 3. JavaScript 代码归属

```text
UI -> App -> Domain
       |
       v
    Adapters
```

- `src/domain`：纯计算、合法性、不可变契约和状态转换；禁止 DOM、HTTP、数据库和存储。
- `src/app`：一次用户操作的编排、store 和 view-model；可以依赖 Domain 和注入的 Adapter。
- `src/adapters`：HTTP、Google、Strava、Bluetooth、FIT 和浏览器存储。
- `src/ui`：View、renderer、事件绑定和展示。
- `src/server`：迁移期 Node BFF。只保留浏览器边缘能力和机械代理，不新增后台领域逻辑。
- `src/shared`：没有 Rider 业务含义的通用工具。

如果一个修复同时涉及 UI 和规则，先把规则放到 Domain/App 并测试，再让 renderer 只消费结果。例如，
按钮禁用原因必须来自 `deriveRideReadiness` 或 capability 投影，不能在事件处理器中重新拼一套条件。

## 4. Python 代码归属

- `app/`：HTTP 与 CLI 入口，只做解析、认证、错误映射和 application 调用。
- `agent/main_agent/`：主模型循环、Skill 激活、Tool 白名单和 dispatch。
- `agent/skills/`：自然语言行为说明与每轮允许的工具集合。
- `agent/tools/`：Tool schema 和薄 handler，不承载 provider、数据库或复杂业务算法。
- `services/`：可复用、可确定性测试的业务用例和规则。
- `operations/`：同步、上传、批处理和可恢复工作流。
- `storage/repositories/`：数据库读取、写入和事务边界。
- `integrations/`：外部 Provider、账号和模型客户端。
- `domain/contracts/`：跨层稳定契约；不要为临时字典机械增加 schema。

依赖方向由 `services/training-agent/tests/test_architecture.py` 约束。修改 import 边界后应优先运行该测试。

## 5. 关键业务时序

### 5.1 AI 路线规划和修改

```text
路线页面输入
 -> Browser route planner/service
 -> Node /api/agent/chat
 -> Python 独立 Route Agent（request_mode=route_plan）
 -> 澄清问题或真实路线 Tool（见 route-agent-implementation.md）
 -> Tool handler 校验结构化参数
 -> route service 生成/修改候选
 -> AMap 或 Google provider
 -> 距离、约束和质量排序
 -> Browser 预览候选
 -> 用户最终确认
 -> Python 原子确认 plan revision + SavedRoute
 -> Browser 构建 runtime route
```

排查顺序：先确认 Skill 是否选对工具和参数，再看 handler 是否完整转发，随后检查 provider 原始证据、
service 的拒绝/排序，最后检查前端是否因 stale revision 或路线 fingerprint 丢弃响应。路线名称或 Agent 文案
正确不代表几何和约束已经生效。

主对话先由模型激活 plan-routes Skill，再委派同一个 Route Agent；成功结果可通过“打开路线草稿”
进入 AI 路线页面。打开使用原会话的 get command 和显式 plan/revision，不重新规划。
父级 Skill 指导位于 route/plan-routes.md，子级业务指导位于 route/execute-routes.md。
实现与剩余边界见 [Route Agent 实施记录](route-agent-implementation.md)。

### 5.2 开始、结束和续骑

```text
选择路线/课表/控制模式
 -> deriveRideReadiness
 -> 开始前保存允许持久化的路线
 -> 冻结 session 中的路线与课表
 -> 实时引擎推进距离并生成设备命令
 -> 正常结束生成 FIT
 -> Python 原子归档活动/facts/artifact/路线关联
 -> 更新 route_progress 为 paused 或 completed
```

控制模式允许骑行中切换，但路线和课表按既有会话规则处理。debug 只替代设备/功率输入，不绕过路线、
可信海拔或控制模式的业务校验。

### 5.3 活动分析与外部上传

```text
本地活动或 Garmin FIT
 -> Python 活动目录/ingestion
 -> 确定性 facts 和曲线
 -> Agent 分析报告（可选）
 -> Strava 上传（可选）
 -> 每个活动独立返回分析与上传结果
```

活动 ID、FIT 路径、分析报告和 Strava 上传状态是不同事实。批量工作流中一个活动失败不能让其他活动
丢失结果；网络超时应标记为可重试外部失败，不能伪装为“没有活动”或确定性分析失败。

### 5.4 路线讲解

```text
用户在街景中选择加载
 -> Browser 计算 route fingerprint 并提交短请求
 -> Python Job store 持久化任务
 -> Worker 有限检索地点并进行一次模型组合
 -> 保存 route_narration 计划
 -> Browser 轮询并校验 fingerprint
 -> narration timeline 按距离/时间切换卡片
```

讲解慢时分别记录排队、地点检索、模型组合和保存时间，不要只扩大 Browser HTTP 超时。路线切换后，
旧 fingerprint 的迟到结果必须丢弃。

## 6. Browser API 迁移规则

浏览器公开面由 `tests/contracts/rider-browser-http-api.v1.json` 固定。迁移一个接口时按以下顺序：

1. 记录 Node 当前 method、path、status、JSON/文件响应和安全行为。
2. 在 Python 实现同 URL、同输入和同错误语义。
3. 同一 fixture 分别请求 Node 与 Python，比较契约而不是只比较 200 状态。
4. 验证 Host、Origin、loopback/token、路径穿越和敏感错误脱敏。
5. 切换 owner 后删除 Node 的业务实现，只保留必要代理。
6. 当前默认已切到 Python :8787；完成剩余验收前保留 `start:legacy`，不要删除旧 Node。

## 7. 排障方法

如果 Windows 上 `npm start` 打印命令后立即返回 PowerShell，先检查 `python --version` 和
`Get-Command python`。退出码 `9009` 且路径位于 `WindowsApps` 时，通常命中了应用别名，
实际 Python 尚不可用。使用有效的 Python 3.12+
解释器设置当前终端的 `PYTHON_EXECUTABLE`，执行 `npm run setup:agent` 建立项目环境；之后清除临时
覆盖，让启动器使用 `services/training-agent/.venv`。启动包装器会显示异常退出码和所选解释器。

`WinError 10048` / `Address already in use` 表示端口已被其他进程占用，无需重新安装 Python。
先确认占用进程；需要临时换端口时可运行 `npm start -- --port 8788`，浏览器使用对应端口。
如果配置了固定 `app_base_url` 或 Strava OAuth 回调地址，也需要与实际使用的入口一致。

先定位失败属于哪一层：

| 现象 | 首先检查 |
| --- | --- |
| 点击无反应 | DOM 引用、事件绑定、按钮 disabled、renderer 重绘是否替换节点 |
| UI 显示可用但启动被拒 | capability 异步刷新、store 第二次更新、`deriveRideReadiness` 输入 |
| 路线生成成功但确认失败 | plan ID/revision、candidate ID、fingerprint、保存事务 |
| 路线修改没生效 | Skill Tool 参数、handler 转发、provider 是否重新请求、stale response |
| FIT 有文件但活动无详情 | ingestion、activity/facts/artifact 事务及稳定 activity ID |
| 批量活动部分结果消失 | 每项 workflow 状态、失败隔离、结果投影与 presentation 去重 |
| 讲解一直准备或超时 | Job 状态、Worker lease、Places/LLM 分段耗时、fingerprint |
| Strava/Garmin 失败 | 静态配置、OAuth/认证、scope、网络和可重试错误分层 |
| WSL/Windows 行为不同 | runtime path resolver、路径分隔符、文件只读语义、Python executable |

诊断请求默认只做只读检查。先用 `rg` 找入口、调用方和测试，再运行最小复现；不要在原因未确认时同时
重构多个层级。

启动日志中的 `worker_started` 是正常就绪信息。缺少 `xdg-open` 时按提示手动打开页面即可，
也可用 `RIDER_OPEN_BROWSER=false` 关闭自动打开。Strava 授权交换、上传或状态查询的网络异常
会记录 `strava_request_failed operation=... error=...`，接口返回简短的 502/504 说明；
`SSLError` 只证明 HTTPS 连接失败，不能据此断言一定是代理问题。发布请求不会自动重放，
应先检查已有活动或上传状态，再决定重试。

## 8. 测试与验收

常用命令：

```bash
npm test                         # JavaScript/Node 单元测试
npm run test:agent               # Python 全量测试
npm run test:integration         # 正常双进程集成
npm run test:degraded            # Python/Agent 不可用及恢复
npm run test:all                 # 以上完整集合
python -m compileall -q services/training-agent
git diff --check
```

改动后的最低证据：

- 规则修改：至少一个正常、一个拒绝和一个边界用例。
- 异步 UI：覆盖初始状态、请求完成后的第二次 store 更新、过期响应和重试。
- 持久化：覆盖成功、事务中途失败回滚、重复请求和旧数据兼容。
- 外部 Provider：使用 fixture 测确定性解析；真实网络只作为单独验收，记录网络与代码结论。
- Browser API：Node/Python 契约对照、安全边界和错误状态。
- 实时骑行：readiness 与实际 start 使用同一结论，并验证 debug 不越过安全规则。

测试全部通过不等于完成。还要检查调用链中是否存在未被套件覆盖的状态转换、跨进程字段和真实数据形态。

## 9. 文档和交付

完成功能时同步更新：

- 用户能力或配置：根 README 和 `feature-capability-matrix.md`。
- 业务契约：对应专题文档。
- 架构切片：ADR，包含解决的问题、明确未做的范围和验证。
- 延后问题：`known-issues-and-technical-debt.md`。
- 模块/命令/owner 变化：本指南和 `docs/README.md`。

提交前只暂存本次文件，检查 staged diff，并按 `commit-convention.md` 写清 Root cause、Changes 和实际
Validation。除非用户明确要求，不执行 push、merge、分支删除或历史改写。
