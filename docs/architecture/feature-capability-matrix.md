# 本地配置与功能能力矩阵

Rider 的基础骑行不要求配置大模型或在线地图。根目录 `config.yaml` 是正式功能的唯一配置来源；
浏览器不再单独保存或弹窗输入 Google API Key。配置变更后需要重启本地服务。

## Provider 状态

Python `/health` 返回 `training_backend_capabilities.v2`，前端只消费结构化的 `providers` 和
`capabilities`，不根据输入框或错误文本自行猜测能力。这里的“已配置”只表示静态配置完整；
Strava、Garmin、Google 等服务是否已授权、配额是否充足、网络是否可达，仍由实际请求返回。

| 配置 | 打开的能力 | 缺失时的行为 |
| --- | --- | --- |
| 无外部配置 | GPX/本地路线、自定义距离线路、活动详情、FIT、固定阻力与 ERG、自定义训练 | 在线地图、AI 与账号同步不可用 |
| `agent.base_url/api_key/model` | 活动分析、训练趋势 | 不影响基础骑行和活动读取 |
| `google.api_key` | 地图选点、地图探索、Street View、Google 参考海拔 | 对应入口禁用并显示配置原因 |
| Agent + Google | 国外 AI 路线、路线讲解 | 任一缺失都不启动相关 Agent 流程 |
| Agent + Google + `amap.web_service_key` | 国内 AI 路线 | 缺 AMap 时不宣称支持国内 AI 路线 |
| Strava client 配置并完成 OAuth | 活动上传、Strava 路线目录/GPX 导入、路段能力 | 静态能力和用户授权状态分开判断 |
| Garmin 账号 | Garmin 活动同步 | 认证或网络失败返回具体阶段与可重试原因 |
| `athlete` | FTP、心率区间和训练指标个性化 | 字段不全时仍可使用，但分析精度下降 |

`amap.js_key` 和 `amap.security_js_code` 仅供隔离的高德 Web Demo 使用，不属于 Rider 正式页面能力。

## 路线与控制模式

路线几何、海拔展示和骑行台控制是三件不同的事。`hasElevationData=true` 只说明有可展示的海拔，
不能单独证明数据可以控制骑行台。

| 路线来源 | 可显示地图 | 可显示海拔 | 可用于坡度模拟 |
| --- | --- | --- | --- |
| 带内嵌海拔的 GPX | 是 | 是 | 是 |
| Strava 同步路线 | 是 | 是 | 是 |
| 不带海拔的 GPX | 是 | 否 | 否 |
| AI 路线 | 是 | 视结果而定 | 否 |
| Google 地图选点/探索 | 是 | 可请求估算参考 | 否 |
| 手工距离/坡度路段 | 无真实地理轨迹 | 可显示手工值 | 否 |

坡度模拟使用 `elevationSource` 做确定性校验，目前只信任 `gpx_embedded` 和 `strava_route`。
`google_estimated` 仅用于路线图表、累计爬升概览和预览，不发送 SIM 坡度命令。debug 模式只替代
功率源和真实设备，不会绕过这条海拔来源规则。

固定阻力、ERG 和自定义 ERG 课表可以在没有地理路线时开始。没有 Google API 时，用户仍可导入
GPX、加载本地/Strava 已缓存路线、编辑纯本地的自定义距离线路，或直接执行自定义训练；地图探索
与地图选点不会退化成没有坡度意义的“平路路线”。

## 前端呈现规则

- 不可用入口保持可解释的禁用状态，`title`/状态文本指出缺少的 Provider。
- 当前在线路线模式变为不可用时，路线工作区回到“我的路线”。
- 街景只读取统一运行时 Google 配置；加载失败不会要求用户在浏览器再次输入 Key。
- Google 参考海拔在按钮、状态和路线概览中统一标注“参考”，避免误解为坡度模拟数据。
- 开始骑行仍由 `deriveRideReadiness` 最终校验，UI 禁用不代替业务校验。
