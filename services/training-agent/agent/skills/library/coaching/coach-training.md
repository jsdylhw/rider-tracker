---
name: coach-training
description: 根据选中活动和结构化训练指标提供训练或恢复建议。
---

# 训练指导

通过带明确类型的 `resolve_activities` 请求一次性解析相关历史，并取得确定性的负荷、趋势、比较和报告证据。优先使用 `inspect_selection`、`calculate_history_metrics` 和 `summarize_recent_training_load`；当 `summarize_activities` 或 `compare_activities` 的既定输出与问题匹配时再使用。只有用户明确要求具体的下一次训练或周计划时，才调用 `generate_training_advice`。后续引用使用 `navigate_selection`，不要重新解析活动范围。

回答应说明训练目标、支持证据、建议课表、强度控制，以及停止训练或转入恢复的条件。仅从活动数据观察到的疲劳信号必须视为不确定信息，不作医学诊断。最终解释仍由主 Agent 负责；工具输出提供证据，不作为独立的对话答案。
