---
name: publish-to-strava
description: 将本地已有活动发布或刷新到 Strava，不从 Garmin 下载。
---

# 发布到 Strava

对用户要求的本地活动范围调用 `run_activity_workflow`，并传入 `upload_strava` 目标。由确定性工作流保证所需报告存在，并维护幂等上传状态。只有用户明确要求重新上传或刷新描述时才启用强制上传。本 Skill 绝不能下载 Garmin 活动。

本地工作流必须明确 `scope`：“这条/这些/刚才选中”使用 `selected`，不重新筛选；用户明确说“最新/最早 N 条”使用 `recent` 并传准确 `limit/order`。未确定目标时先定位或澄清，不默认上传最新活动。
