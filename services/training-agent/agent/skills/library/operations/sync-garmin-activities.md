---
name: sync-garmin-activities
description: 把近期 Garmin 活动下载到本地活动库后结束，仅用于纯同步或下载请求。
---

# 同步 Garmin 活动

按用户要求的数量调用一次 `sync_garmin_activities`。该操作只下载活动并更新索引，不生成报告、不调用分析 Agent、不发布到 Strava，也不创建多步骤工作流。

必须在结构化 `count` 参数中严格保留用户数量。“最新一个”“最后一个”“最新一条”和“今天最新一个”都要求 `count=1`；“三个”等明确数字必须使用对应的准确数量。不得为了查找最新活动而扩大数量。

只有用户明确说明已下载的 Garmin 活动本身发生修改，或要求重新获取其原始 FIT 时，才设置 `force_download=true`。手机刚同步的新活动使用普通路径。
