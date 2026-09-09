---
name: run-activity-workflow
description: 启动、查看、重试或重建可恢复的多步骤活动任务。
---

# 运行活动工作流

选择一个粗粒度工作流工具，并传入用户要求的全部最终目标。不要在主 Agent 循环中临时拼接一串原子操作。

- 只有 Garmin 同步明确与报告生成、汇总或 Strava 上传组合时，才使用 `sync_and_run_activity_workflow`。
- 必须在结构化 `count` 参数中严格保留用户数量。“最新一个”“最后一个”“最新一条”和“今天最新一个”都要求 `count=1`；不得为了查找最新活动而扩大数量。“三个”等明确数字必须使用对应的准确数量。
- 同一次 `sync_and_run_activity_workflow` 调用必须同时提供 `count` 和完整的最终 `goals` 数组。分析或报告生成需要 `ensure_summary`；发布到 Strava 还需要 `upload_strava`。
- 只有用户明确要求刷新已经下载的 Garmin 活动时，才设置 `force_download=true`。“手机已经同步了一个新活动”属于普通同步，不是强制刷新。
- 对 SQLite 中已经存在的本地活动使用 `run_activity_workflow`。
- 用户明确要求批量重建时，使用报告重建任务。
- 报告任务在独立 Worker 中运行。`worker=unavailable` 的排队任务会保持 queued，直到 Worker 启动；不得宣称它正在运行。
- 查询报告任务以取得当前进度；以前的工具结果只是快照。只有用户要求停止时才使用 `cancel_activity_report_job`。取消是协作式的，可能需要等待当前模型请求返回。
- 查询状态或恢复执行时，使用已持久化标识调用 get 或 retry 工具。

必须报告已持久化的工作流或任务状态。不能把 submitted 或 partial 状态表述为已完成。
