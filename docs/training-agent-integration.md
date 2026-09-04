# Training Agent 集成说明

## 当前边界

Rider Tracker 是唯一面向浏览器的产品入口。Node 服务负责页面、Web Bluetooth、FTMS、实时骑行、活动文件和确定性安全控制；内置 Python Training Agent 负责对话、历史活动分析、Garmin/Strava 工作流以及路线规划。

两个运行时位于同一 Git 仓，但保持两个进程：

```text
Browser -> Rider Node -> Training Agent Python
```

Rider 是唯一浏览器入口。Python Backend 的 `/` 只返回服务元信息，`/health` 用于启动检查；
它不再提供独立 HTML、CSS 或浏览器 JavaScript。

这一边界可以避免慢速模型或地图请求阻塞实时骑行控制，也允许 Python 分析代码继续使用现有库。

## 浏览器入口

首页 Agent 浮窗已接入真实 `/api/agent/chat` 链路，可查询本地活动、读取完整报告和分析训练历史。
Python 返回的公开结果由 `answer` 和 `presentations` 组成：正文进入对话，结构化卡片、表格、
趋势曲线和 Markdown 进入结果工作区。首页 Agent 与路线规划使用不同 session；路线候选仍在
专用路线页面完成预览、语义修改和确认。

单活动定位可能先产生轻量 `kind=activity_selection`，随后产生完整报告或确定性检查结果。
Presentation 投影采用“更完整结果覆盖定位预览”的规则：存在 `kind=activity_report` 或
`inspect_selection` 的持久化 `analysis_result.v1` 时，不再重复投影 selection 的指标卡和活动过程曲线。

### Schema 与内部结果边界

稳定契约统一登记在
[`domain/contracts/schemas.py`](../services/training-agent/domain/contracts/schemas.py)。只有跨进程、
持久化、缓存恢复或重放的数据才使用 `schema_version`。普通 Python 函数和 Agent 工具的临时结果
使用 `kind` 或 `operation`，不再为每个函数创建独立版本协议。

当前浏览器只需要理解 `agent_turn.v1` 和 `presentation.v1`。活动定位、完整报告、训练趋势和
Strava 路段发现是 Python 投影层内部的 result kind；投影层仍兼容旧日志中的
`activity_selection.v2`、`activity_report.v1` 等名称，但新结果不再生成这些伪 schema。

SQLite 与可恢复状态暂时保留现有格式，包括 `activity_metrics.v2`、`activity_features.v1`、
`llm_fit_file_analysis.v2`、`workflow_run.v1`、`analysis_result.v1` 和 `route_plan.v1`。这些格式
只有在提供显式迁移和兼容验证后才能改名或合并。

后续语音能力沿用同一边界，但拆成两条输入链路：训练播报读取已经存储的活动、课表和路线状态，
不强制依赖功率计实时数据；地点介绍从 GPX/当前路线抽取少量代表坐标，查询地点资料后交给模型
整理成短播报稿，最后由本地 TTS 合成。地点查询、文案生成和 TTS 都不得进入实时 FTMS 控制循环。

路线讲解的前端契约和本地时间线已按 [`route_narration_plan.v1`](./route-narration.md)
建立。进入街景后由用户决定是否准备讲解；Python 服务在 4-8 个代表点并发查询 Google Places，
再通过单次模型调用生成有来源的结构化卡片，不运行开放式搜索工具循环。浏览器只缓存本次骑行，同一路线返回街景不会
重复请求。当前尚未接入通用网页搜索、持久化讲解计划和本地 TTS。

国外环线地点检索采用首个已解析地点作为局部锚点，后续 Google Places 查询带位置偏置，并按
直线距离选择同一国家内最近的结果。存在目标距离时，途经点不得超过
`max(5 km, 目标距离 × 0.75)`；完成算路后只保留目标距离 60%-150% 的候选。超界候选在
Python 服务层确定性淘汰并记录原因，不能依赖模型或前端隐藏。

同一批路线候选相互隔离：单条候选的地图检索、算路或范围校验失败只会进入
`rejected_candidates`，不得丢弃已经成功的候选并触发整批重算。路线计划顶层的目标距离会作为
未单独声明距离的候选默认值，确保实际算路结果都经过同一距离门槛。

Rider 的虚拟 ERG 路线通过 `/api/chat` 的请求级 `route_options` 明确传递
`include_elevation=false`，Python 在当前工具执行期间覆盖模型参数并在请求结束后清空，不能把该
选项写入会话记忆。长时间地图请求仍是同步请求；路线对话框以本地阶段提示和已等待秒数说明进展，
这些提示不是服务端完成事件，也不改变最终路线状态。

统一启动器会把 `agent.base_url` 的主机追加到 `NO_PROXY/no_proxy`，让模型请求直连；Google、
Strava 等地图和业务服务不加入该列表，继续使用操作系统现有代理配置。

## 代码来源

`services/training-agent/` 从 Personal FIT Agent 的固定提交导入。运行时数据、FIT、日志、SQLite、地图数据和 Token 不属于迁移内容。后续同步原仓改动时应使用明确提交，不要直接复制脏工作区。

根目录 `config.yaml` 是 Rider 与 Training Agent 的唯一人工配置入口，模板为 `config.yaml.example`。启动器将同一份 YAML 映射为 Node 环境变量，同时通过 `TRAINING_AGENT_CONFIG_PATH` 交给 Python。环境变量只用于临时覆盖，不再维护第二份 Agent 配置。

## 本地数据

Rider 与 Training Agent 现在共用根目录下的 SQLite 数据库，默认路径为
`data/rider-tracker.db`。启动时 Node 只调用 Python 的 `database-tool.py ensure`；Python 检查
schema，数据库不存在或版本不匹配时才初始化或备份后迁移，已就绪时不会重复迁移。也可以使用
`npm run db:migrate` 显式执行带备份的迁移。Python 解释器完全不可用时，Rider 基础页面仍可启动，
数据库能力明确降级；Python 存在但检查失败时则停止完整启动。Node 不打开 SQLite，也不持有 schema
版本或表结构规则。

- `activities` 保存活动身份、摘要和原始 FIT 路径。
- `activity_facts`、`activity_reports` 保存 Agent 生成的确定性特征和报告。
- `activity_artifacts` 保存可重建的详情曲线/地图序列，避免每次打开活动都重新解码 FIT。
- `athlete_profiles` 是 FTP、体重、最大/静息心率和骑行模拟参数的唯一事实源；Rider 设置页通过 Node 代理访问 Python，不再直接保存这些字段到 `user-profile.json`。数据库尚无档案时，Python 可一次性兼容导入统一配置、旧 Agent 档案或 Rider 根目录旧文件，导入后始终以数据库为准。
- `route_plans`、`route_plan_revisions` 保存 Agent 路线草稿及修改历史。
- `saved_routes` 保存 Rider 已确认的路线资产；`route_progress` 单独保存未完成进度。
- `activities.saved_route_id` 及路线起止里程把完成活动关联到实际骑行路线。
- `chat_sessions` 保存可恢复的对话状态。
- 原始 FIT 文件统一保存在根目录 `data/files/fit/`，数据库只保存相对路径或必要的绝对路径。

Strava 也由 Python 单独持有外部副作用：凭据来自 `config.yaml`，OAuth Token 默认保存在
`data/credentials/strava-tokens.json`，Token 刷新、活动上传和状态查询都通过 Node 代理进入 Training Agent。
旧 Node Token 文件的 `default` 包装格式会在首次读取时兼容，后续写入统一的单用户格式。

FIT 历史解析也只有一个生产入口：`services/activity/fit_loader.py` 从数据库读取统一运动员档案并显式注入纯 FIT parser。JavaScript 继续负责实时记录、导出与页面适配，不再作为历史 FIT 指标的权威来源。

共享数据库不等于允许任意跨层写入。Rider 负责实时骑行和文件接收，Agent 负责
分析派生数据和路线计划；两边通过稳定的 `activity_id`、`plan_id` 关联。

## 验收层次

1. `npm test`：Rider 的确定性逻辑和 UI 单元测试。
2. `npm run test:agent`：Python Agent 全量测试。
3. `npm run test:integration`：使用临时端口和临时 Rider 数据库启动两个真实进程，验证健康检查和代理链路。
4. 在线验收：显式使用本地账号验证模型、Garmin、Strava、高德和 Google，不纳入默认 CI，也不默认产生上传副作用。

## 后续整理

最终目标、阶段编号与执行顺序见
[`rider-final-architecture-and-python-migration.md`](./rider-final-architecture-and-python-migration.md)。

实时骑行的准备规则、debug 边界、FTMS capability 和模式切换见
[`ride-readiness-and-control.md`](./ride-readiness-and-control.md)。
