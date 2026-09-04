# 路线文字讲解与语音边界

## 目标

路线讲解首先验证“文字内容是否可信、骑行到哪里显示哪一条”，再接入本地 TTS。讲解主要展示在沉浸街景右侧，但不属于街景移动逻辑，也不能阻塞骑行、FTMS 控制或路线渲染。

```text
进入街景：用户确认 -> 代表点并发地点检索 -> 单次模型编排 -> route_narration_plan.v1
骑行中：distanceMeters -> NarrationTimeline -> 文字卡片 -> （后续）TTS 播放
```

## 当前实现

当前版本完成文字讲解链路：

- 进入沉浸街景不会自动联网；右侧卡片先询问是否加载，关闭后不影响街景和骑行。
- 用户确认后，讲解服务先确定少量路线代表点并发查询 Google Places，再把全部地点资料、路线采样和目标密度一次性交给模型生成整套卡片。模型只有结构化提交能力，不再自行发起搜索、读取来源或修复回合。
- `narration-plan.js` 定义 `route_narration_plan.v1`、路线指纹和输入规范化；生产代码不包含演示讲解。
- `narration-timeline.js` 只依据当前累计里程和骑行时间选择讲解，默认提前 300 m、过点 500 m 失效、自动讲解最小间隔 75 秒；手工翻页保留 10 秒后恢复自动跟随。
- `route-narration-service.js` 按 route fingerprint 保存当前骑行会话内的请求和结果；返回页面再进入同一路线不会重复请求，骑行结束后清空。
- `route-narration-renderer.js` 只通过 `textContent` 写入沉浸街景右侧卡片，支持手工查看上一个/下一个。

路线快照按预计时间约每 4 分钟采样，最多 48 个点。存在海拔剖面且运动员参数完整时，预计时间复用 Rider 骑行物理模型，按 `60% FTP` 的稳定功率逐段计算；缺少剖面或运动员参数时，才回退到路线显式时长或 `24 km/h`。因此相同距离的持续爬坡会比平路生成更多采样和讲解卡片。标准密度约每 5 分钟一张卡片：约一小时路线目标 11-12 张、最低约 9 张；两小时路线目标约 24 张，允许在 20-32 张之间浮动。资料确实不足时仍可返回更少的 `partial` 计划，但不能编造填充。

卡片数量与外部搜索次数相互独立。讲解分为两类：

- `route`：路线总览、区域地理、水系、生态、历史、人文、地方生活、骑行节奏、安全和终点回顾。`sample_id` 只决定播放时机，资料来源不要求来自该采样坐标；同一组可靠来源可以支撑多张不同主题卡片。
- `place`：桥梁、寺院、山峰等确切沿途地点。来源必须确实在对应采样点附近，而且只占全部卡片的一小部分。两小时路线最多 8 张点位卡片。

研究阶段不会遍历全部展示采样点，也不会按卡片逐条搜索。代表点数量随预计时长缓慢增长并限制在 4-8 个；每个代表点只发送一次 Google Places 请求，所有请求并发执行。两小时路线通常为 6 次 Places 请求，结果汇总后只调用一次模型。失败的单点会形成计划 warning，不会使整批资料失效。

结构化提交由后端一次校验：未知来源、缺少正文和重复采样点等无效卡片直接丢弃；有真实来源但不满足精确采样点关系，或超过点位卡片上限的内容会降级为不带地点图片的 `route` 卡片。只要仍有有效卡片就立即返回 `partial` 计划，不再要求模型重新搜索或重写。这样一次讲解准备的正常上游调用数可预测为“4-8 次并发 Places + 1 次 LLM”。这次确定性的结构化编排会单独关闭模型 thinking，以便强制一次提交；不会改变主 Agent 和活动分析的 thinking 配置。

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
      "media": {
        "type": "google_place_photo",
        "photo_name": "places/place_id/photos/photo_id",
        "width": 1200,
        "height": 800,
        "author_attributions": [],
        "source_url": "https://www.google.com/maps/..."
      },
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

`summary` 是当前权威文字，通常为 160-280 个中文字、分成两个短段落，优先解释背景、具体事实及其与沿途景观或骑行体验的关系。讲解卡片允许纵向滚动并保留文本换行。`tts_text` 是独立的 40-90 字口语短稿；二者分开，避免为了 TTS 的简短口语化而压缩页面信息。

`media` 只自动附加到来源和采样点一致的 `place` 卡片；区域级 `route` 卡片不强行配图，避免把单一景点误当成整段路线的代表。Places 搜索只返回短期照片引用，准备讲解时不下载图片；当前卡片出现后，浏览器才通过 Rider 的 `/api/route-narrations/photo` 请求，Node 和 Python 在本地代理 Google Place Photo，因此 Google API Key 不进入浏览器。图片失败时卡片保持纯文字，作者署名随照片显示，照片响应使用 `no-store`，不把可能过期的 photo name 当作持久资源缓存。

## 请求和缓存边界

- 缓存只存在于本次骑行的浏览器内存，不写数据库或 localStorage。
- 同一 fingerprint 的 `loading` 请求和 `ready` 计划会复用；路线变化使用新身份，旧异步结果不能覆盖当前卡片。
- 用户关闭提示不保存为长期拒绝；下次进入街景仍可选择加载。
- Node 仅代理请求；Python 讲解服务负责代表点选择、并发地点检索、单次模型编排和结构化校验。
- 当前搜索 provider 是 Google Places。通用网页搜索仍应通过 provider 接口补充，不能把 Places 描述冒充完整网页研究。
- Google Places 返回的景点照片只用于补充街景无法呈现的景点视角；右侧卡片按当前项懒加载，不在讲解准备阶段批量下载。
- 后续再增加后台 job 进度、取消、通用网页搜索，以及本地 TTS、文本哈希音频缓存和下一条预取。

任何准备失败都只在讲解卡片中显示错误和重试入口，不能影响地图、街景、FTMS 或骑行开始。
