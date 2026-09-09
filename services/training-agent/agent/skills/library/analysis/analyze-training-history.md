---
name: analyze-training-history
description: 使用结构化指标总结、比较或计算多条活动的训练趋势。
---

# 分析训练历史

通过一次带明确类型的 `resolve_activities` 调用解析用户要求的范围；解析成功后冻结活动顺序。`kind=recent` 只用于“最近 3 条”等数量请求，并使用 `limit=3` 表达数量。任何时间段都使用 `kind=range`：“最近 30 天”或“最近一个月”必须传 `kind=range, days=30`，日历表达可以使用 `relative_range`。不得把 `days`、`relative_range`、`start_date` 或 `end_date` 与 `kind=recent` 混用。只有用户明确要求全部历史时才使用 `kind=all`。用户要求的范围数量限制必须放在同一次调用中，并在过滤后应用。

把请求转换为一个或多个证据命题：训练量、强度、表现、效率、一致性或可能的恢复压力。需要纵向结论时调用 `analyze_training_history`；它返回内部 `kind=training_history_analysis` 结果，再由展示投影器转换为带版本的 Rider 展示协议。只有用户要求原始周/月序列时才使用 `calculate_history_metrics`；仅查询负荷事实时使用 `summarize_recent_training_load`；明确比较有限条活动时使用 `compare_activities`。无需报告的集合概览使用 `inspect_selection`。只有已保存报告的叙述明确有用时才使用 `summarize_activities`。

对“第二条”等后续引用使用 `navigate_selection`。不得对范围内每条活动逐一调用单次活动报告工具，也不得仅为查看集合而生成缺失报告。

读取结构化活动指标，不要从生成文本中提取数字。除非用户明确要求合并训练量，否则按运动类型分开；绝不能把骑行功率与跑步配速比较。区分观察到的变化和解释；在声称体能或疲劳变化前，说明数据覆盖、传感器缺失、阈值或负荷方法变化以及混杂因素。

`scope.current_period` 是包含选中数据的最新周期，并不自动等于当前日历周期。必须遵守其 `status` 和 `as_of` 字段：不能把 `closed` 周期描述为“仍在进行”。活动覆盖稀疏时，应说明观察到的活动数、活跃天数，或没有更晚的活动记录；不得篡改日历状态。

遵循加载的方法论和输出契约。负荷增加本身不等于体能提升，一次表现不佳也不等于累积疲劳。缺少匹配训练、稳定效率证据、主观恢复、天气或路线背景时，把相应维度标记为不可用，不得编造。每项主要结论都必须给出置信度和最主要限制。
