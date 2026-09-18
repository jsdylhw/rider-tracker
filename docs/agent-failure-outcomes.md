# Agent 失败出口收敛

实施日期：2026-09-16。对应 [Agent 流程检视报告](agent-flow-inspection-report.md) 第一切片。
本记录独立于 Python 后端迁移 ADR，不修改最终架构文档。

## 范围和结果

不拆 Route Agent、不迁移 Worker、不引入恢复状态机。先保留本轮真实失败原因。

| 场景 | status / code | 含义 |
| --- | --- | --- |
| 模型请求失败 | llm_unavailable / llm_unavailable | 保留实际执行记录，不覆盖成缺动作 |
| 初始化失败 | llm_unavailable / llm_initialization_failed | 尚未调用工具，需要检查配置 |
| Guard 拒绝 | blocked / guard_rejected | Handler 未执行，不进入重放队列 |
| 无错误码的工具失败 | tool_failed / tool_failed | 工具执行失败，不等同于未调用 |
| Provider 失败 | provider_error / 原错误码 | 保留 provider、stage、retryable |
| 路线业务拒绝 | route_rejected / 原错误码 | 不伪装成网络故障 |
| 预算耗尽 | max_steps_exceeded / budget_exhausted | 保留独立预算原因 |
| 没有要求的工具结果 | action_not_executed / action_not_executed | 不凭模型文字宣告业务完成 |

## 公开诊断和 UI

`agent_turn.v1` 增加可选 `error`，只公开 code、stage、provider、retryable、message。
不公开工具输入、原始结果或 traceback；本地模型/Guard 错误不虚构 provider。
路线 UI 转为 `AgentRouteError`，保留上述字段；失败响应即使夹带旧 route_plan 也不能加载。
成功的终结工具结果继续确定性展示，不强制增加模型总结。

## 验收

- Guard 拒绝后 Handler 不执行，公开 blocked 原因，不保存重放动作。
- 初始化失败无旧 trace 或旧路线，模型错误不被完成策略覆盖。
- 正常与直接重试消费同一失败投影；无错误码工具失败与未调用区分。
- 预算耗尽保留独立原因；公开诊断剔除内部字段。
- 前端拒绝加载错误响应中的旧路线。

组合路径补充：前置定位成功不能掩盖后续分析/上传失败。失败筛选独立于策略的完成工具白名单，
非必需工具被 Guard 拒绝也保留公开原因。失败识别复用统一工具失败判定，支持仅有 status=failed、
嵌套 result.error 和上传失败；没有稳定错误码时补 tool_failed，不否认工具已经执行。
只有同一工具、同一参数目标的后续成功重放才消除之前失败；不同活动的成功不代表失败活动已恢复。

后续已在 [Route Agent 实施记录](route-agent-implementation.md) 中定义共用任务输入、澄清、父子结果契约与跨入口草稿接续；本页保留失败出口切片的验收记录。

本切片验收：JavaScript 426/426、Python 760/760；正常和后端掉线/恢复双进程集成通过，
compileall 与 git diff --check 通过。组合回归使用隔离 Context/Provider，不调用真实模型或地图。
