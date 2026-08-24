# Personal FIT Agent — 项目结构

## 顶层职责

```text
app/           CLI、HTTP API 入口
agent/         对话编排、分析 Agent、Skills、Tool 合同与适配器
services/      不依赖 AgentContext 的请求-响应型业务用例
domain/        活动与分析的数据合同、纯业务规则
fit/           FIT 解析与时序事实计算
storage/       SQLite 与 Workflow Repository
integrations/  Garmin、Strava、LLM 外部适配器
operations/    同步、批量报告、上传等有副作用或可恢复任务
evaluation/    Skill 激活、工具调用、任务完成与成本评测
data/          本地数据库和运行状态
```

`core/` 与 `sinks/` 已移除。它们原先混合了领域逻辑、存储和第三方接口，现按职责迁入上述目录。

## 运行入口

聊天主链路从 CLI 进入：

```text
python -m app.cli chat
  -> app.cli.chat_command
  -> AgentContext + AnalysisNavigationService
  -> agent.main_agent.loop.run_tool_loop
```

`analyze-file`、`sync-garmin`、`rebuild-facts`、`upload-strava` 等 CLI 命令是确定性运维入口，不经过主聊天 Agent。`app/api.py` 当前提供 Dashboard、Garmin、FIT 分析、报告和 Strava HTTP 接口，但尚未提供 `/api/chat`，所以 Web UI 还没有进入 Main Agent/Skill 链路。

## 对话与分析链路

```text
用户消息
  -> agent.main_agent.loop（首轮只暴露 activate_skill）
  -> 主模型选择并激活一个 Skill
  -> 下一轮只暴露该 Skill 的 Tool 白名单
  -> agent.main_agent.tools.TOOL_HANDLERS
  -> agent.tools.handlers（读取 AgentContext、包装 Tool 结果）
  -> services.activity（显式活动 ID / 活动列表 / 分析请求）
  -> domain + fit + storage
  -> 主 Agent 生成回答
```

活动分析使用统一目标模型：

```text
Activity Scope -> Segment Scope -> Analysis Objective
```

`agent/analysis/workspace.py` 保存当前活动集合、单活动或片段焦点。用户说“看第二个”“比较前两个片段”时复用已保存的具体 ID，不重新依赖模糊对话文本定位。

## 活动定位与导航

```text
ActivitySelectionRequest
  -> resolve_activities
  -> services.activity.resolver.ActivityResolver
  -> SQLite activities
  -> 冻结有序 activity IDs
  -> AnalysisNavigationService.replace_activities
```

Resolver 统一支持 `current/recent/date/range/all/key/index/name`。导航状态由 `root_scope + focus_stack` 表示：

```text
activity_set -> activity -> segment_set -> segment
```

`select` 进入某个序号，`back` 弹出一层，`root` 回到最初冻结集合。短指令“看第二个”“返回”由 `turn_control.py` 确定性处理，不重新调用模型解释活动范围。

## 单活动分析层级

默认采用最小必要分析：

```text
轻量问题
  -> resolve_activities
  -> inspect_selection
  -> activity_metrics.v2 + activity_features.v1

语义片段问题
  -> find_segments
  -> sprint / interval / climb 候选
  -> analyze_selection

精确时间或距离窗口
  -> turn_policy 收窄工具面
  -> query_activity_detail(原始问题)
  -> ActivityQueryAgent
  -> 代码解析窗口并执行原始 FIT 查询
  -> 单次模型综合 + submit_query_answer
  -> 仅返回 answer / evidence / limitations，不生成报告或 Strava 文案

显式完整报告
  -> analyze_activity
  -> 已有 V2 报告直接读取；缺失时由 ActivityAnalysisAgent + submit_analysis 生成
```

## 多活动与历史分析

多活动检查不逐条生成报告：

```text
resolve_activities
  -> inspect_selection / compare_activities
  -> 结构化 facts

历史趋势
  -> analyze_training_history
  -> calculate_history_metrics
  -> activity_metrics.v2
  -> training_history_analysis.v1
```

历史数值、覆盖率、周期序列和可比性判断由 Service 确定性计算；LLM 只负责选择能力和表达结论。

## Agent 与 Tool

```text
agent/
├── main_agent/             主对话循环、上下文、Guard、工具分发
├── analysis/               FIT 分析子 Agent、Prompt、导航工作区
├── skills/                 Skill 目录、加载器和 Skill library
├── tools/
│   ├── agent_tools.py      主 Agent ToolDef 清单
│   ├── handlers/           AgentContext 到 Service 参数的薄适配器
│   └── fit_analysis/       子 Agent 可见的只读 FIT ToolDef/handler
└── runtime/                通用 Tool Loop、TurnResult 与对话日志
```

Tool 只负责 LLM 接口：参数校验、读取会话焦点、调用 Service、包装 `tool_result`。确定性业务实现不放在 Tool handler 中。

## 业务、事实与存储

```text
services/activity/
  catalog.py        活动查询
  analysis.py       已解析目标的单/多活动与片段分析
  comparison.py     多活动确定性比较
  history.py        历史指标聚合
  training_load.py  训练负荷聚合
  reporting.py      当前报告读取

fit/analysis/
  data.py           overview、summary、时间/距离窗口
  metrics.py        activity_metrics.v2
  segments.py       通用区间扫描
  sprints.py        短冲刺探测（当前算法独立保留，后续统一）
  running.py        跑步指标

storage/
  database.py
  repositories/
    activity.py     activities + activity_reports
    analysis.py     navigation + analysis_results
    workflow.py     Run JSON 快照与跨进程锁
```

依赖方向由 `tests/test_architecture.py` 自动约束：`services/domain/fit/storage/integrations` 不得依赖 `agent`；`domain` 与 `fit` 不得依赖外层状态或基础设施。

## 副作用与长任务

普通活动问答不创建 Workflow。只有同步、批量报告、上传及其重试使用：

```text
operations/activity/
  -> operations/runtime（任务状态机与执行器）
  -> storage.repositories.workflow（持久化与排他锁）
  -> services / storage / integrations
```

批量报告任务可调用 `agent.analysis` 子 Agent 生成报告，但不得依赖 `agent.main_agent`、Skill 或聊天上下文。Workflow 不保存聊天推理，只冻结具体活动目标和任务状态。用户取消、进程中断或上传失败时，可根据持久化 Run 恢复；单条定向问答仍走“定位活动 -> 最小必要分析 -> 回答与下钻建议”。

## 活动与报告事实源

```text
FIT 文件
  -> activities（一 FIT 一行）
  -> activity_reports（一活动一份当前 V2 报告）
  -> analysis_results（定向问答/比较等分析产物）
```

`data/personal-fit-agent.db` 是活动和报告的唯一运行时事实源。新报告必须是 `llm_fit_file_analysis.v2`，历史数值从 `activity_metrics.v2` 读取，不从 Markdown 正则提取。

## 评测链路

`skill` 模式复用真实主循环的第一轮，只暴露 `activate_skill`，激活后立即停止；`live` 模式继续渐进暴露业务工具，但使用 `EvaluationSandbox` 替换外部副作用：

```text
skill: EvalCase -> system prompt -> activate_skill -> grade skill_id/public_intent

live:  activate_skill -> Skill tools -> Sandbox handlers
       -> grade tools/arguments/order/result/answer/latency/tokens/cost
```

评测不再维护独立 Selector、置信度阈值或另一套路由协议。

## 外部能力

- `integrations/garmin.py`：认证与下载。
- `integrations/strava.py`：OAuth、上传与描述更新 HTTP 客户端。
- `integrations/llm.py`：Anthropic Messages API 兼容客户端，不导入 Agent Tool 或 Skill。
- `services/route/advice.py`：当前路线建议用例；路线计算 Demo 仍独立在 `demo/`，未接入主 Agent。

## 当前边界

- Web API 尚无 `/api/chat`，现有 Web 页面仍是文件操作面板。
- `casual_chat` 与 `ask_user_clarification` Tool 当前没有 Skill 暴露，普通聊天直接由模型回答；可在后续清理不可达注册项。
- `agent_loop` 是 `execute_tool_loop` 的兼容包装，评测迁移完成后可进一步收紧。
- 路线地图、活动图表和 Artifact 渲染协议尚未进入主线。
