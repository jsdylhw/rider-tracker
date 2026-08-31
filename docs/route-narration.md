# 路线文字讲解与语音边界

## 目标

路线讲解首先验证“文字内容是否可信、骑行到哪里显示哪一条”，再接入本地 TTS。讲解主要展示在沉浸街景右侧，但不属于街景移动逻辑，也不能阻塞骑行、FTMS 控制或路线渲染。

```text
进入街景：用户确认 -> RouteNarrationAgent -> route_narration_plan.v1
骑行中：distanceMeters -> NarrationTimeline -> 文字卡片 -> （后续）TTS 播放
```

## 当前实现

当前版本完成文字讲解链路：

- 进入沉浸街景不会自动联网；右侧卡片先询问是否加载，关闭后不影响街景和骑行。
- 用户确认后，独立 `RouteNarrationAgent` 使用地点搜索、来源读取和最终提交工具生成整套卡片。
- `narration-plan.js` 定义 `route_narration_plan.v1`、路线指纹和输入规范化；生产代码不包含演示讲解。
- `narration-timeline.js` 只依据当前累计里程和骑行时间选择讲解，默认提前 300 m、过点 500 m 失效、自动讲解最小间隔 75 秒；手工翻页保留 10 秒后恢复自动跟随。
- `route-narration-service.js` 按 route fingerprint 保存当前骑行会话内的请求和结果；返回页面再进入同一路线不会重复请求，骑行结束后清空。
- `route-narration-renderer.js` 只通过 `textContent` 写入沉浸街景右侧卡片，支持手工查看上一个/下一个。

路线快照按预计时间约每 4 分钟采样，最多 48 个点。标准密度约每 5 分钟一张卡片：两小时路线目标约 24 张，允许在 20-32 张之间浮动；资料不足时宁可返回更少的 `partial` 计划，也不能编造填充。

卡片数量与外部搜索次数相互独立。讲解分为两类：

- `route`：路线总览、区域地理、水系、生态、历史、人文、地方生活、骑行节奏、安全和终点回顾。`sample_id` 只决定播放时机，资料来源不要求来自该采样坐标；同一组可靠来源可以支撑多张不同主题卡片。
- `place`：桥梁、寺院、山峰等确切沿途地点。来源必须确实在对应采样点附近，而且只占全部卡片的一小部分。两小时路线最多 8 张点位卡片。

研究阶段不会遍历全部展示采样点。每个查询最多选取 3 个均匀分布的代表点，并发数最多 4；两小时路线最多发出 18 次 Google Places 请求。失败的单点只会被跳过，不会使整批资料失效。达到预算后 Agent 必须复用已读取来源并提交完整或 `partial` 计划。

如果 Agent 第一次提交时误用了未读取来源，或把区域资料错误标成点位卡片，后端会把结构化校验错误送回同一讲解会话修正；已经完成的外部搜索不会重跑。

路线指纹只使用总距离及每约 100 m 按里程均匀抽样后的经纬度，不使用名称、来源和海拔。因此路线重命名、后补海拔或轨迹采样密度变化不会误删讲解计划，而实际路线几何变化会重置时间线。

## 数据契约

讲解计划使用 `route_narration_plan.v1`：

```json
{
  "schema_version": "route_narration_plan.v1",
  "plan_id": "narration_xxx",
  "route_fingerprint": "route_xxx",
  "locale": "zh-CN",
  "status": "ready",
  "content_profile": "scenic_culture",
  "route": {
    "name": "路线名称",
    "total_distance_m": 30000
  },
  "items": [
    {
      "item_id": "place_1",
      "route_distance_m": 4200,
      "latitude": 35.0,
      "longitude": 135.0,
      "content_scope": "route",
      "category": "history",
      "title": "地点名称",
      "summary": "用于屏幕阅读的介绍。",
      "tts_text": "用于语音播放的短文本。",
      "trigger": {
        "lead_distance_m": 300,
        "expire_distance_m": 500,
        "minimum_gap_seconds": 75,
        "priority": 5
      },
      "sources": []
    }
  ],
  "warnings": []
}
```

`sample_id` 不进入最终计划，但后端会用它将卡片投影成 `route_distance_m` 和经纬度。`content_scope=route` 允许区域资料安排在任意合适的路线时刻；`content_scope=place` 才要求来源与该采样点一致。

`summary` 是当前权威文字，`tts_text` 是后续语音稿。二者分开，避免为了 TTS 的口语化破坏页面信息。

## 请求和缓存边界

- 缓存只存在于本次骑行的浏览器内存，不写数据库或 localStorage。
- 同一 fingerprint 的 `loading` 请求和 `ready` 计划会复用；路线变化使用新身份，旧异步结果不能覆盖当前卡片。
- 用户关闭提示不保存为长期拒绝；下次进入街景仍可选择加载。
- Node 仅代理请求；Python RouteNarrationAgent 负责搜索、读取来源和结构化提交。
- 当前搜索 provider 是 Google Places。通用网页搜索仍应通过 provider 接口补充，不能把 Places 描述冒充完整网页研究。
- 后续再增加后台 job 进度、取消、通用网页搜索，以及本地 TTS、文本哈希音频缓存和下一条预取。

任何准备失败都只在讲解卡片中显示错误和重试入口，不能影响地图、街景、FTMS 或骑行开始。
