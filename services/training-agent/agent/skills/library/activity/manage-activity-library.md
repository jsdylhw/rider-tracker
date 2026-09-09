---
name: manage-activity-library
description: 查找和查看本地活动库中已有的活动，不执行分析、同步、发布或训练建议。
---

# 管理活动库

使用 `resolve_activities` 建立唯一的当前导航活动集合。需要在同一请求中执行独立辅助查询时使用 `lookup_activities`；它返回相同类型的结果，但不能替换已保存的范围或焦点。只返回数据库中已有的内容，不生成报告，也不推断缺失指标。

- “最新/最近 N 条活动”使用 `kind=recent`，不要附加日期范围。
- 一个自然日使用 `kind=date`，一段时间使用 `kind=range`。用户要求限制数量时，范围的 `limit` 在日期过滤后应用。
- 只有用户明确要求全部历史时才使用 `kind=all`。
- 只有用户明确给出稳定标识、全局目录序号或名称时，才分别使用 `kind=key`、`kind=index` 或 `kind=name`。
- 不得混用属于不同 `kind` 的字段。

单独出现的“最新”或“最近”表示排序。明确的复数数量、时间范围、“全部”或比较范围表示多条活动。对于“第二个”、返回上一级或回到根集合等引用，使用 `navigate_selection`，不要重新解析已经冻结的集合。例如，“最近五条里的第二条，再看全部历史最早一条”应执行 `resolve_activities(recent, 5)` → `navigate_selection(select, 2)` → `lookup_activities(all, earliest, 1)`。只有仍存在两种实质不同的选择时，才提出一个聚焦问题。
