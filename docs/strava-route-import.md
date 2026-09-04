# Strava 路线导入

## 目标

Rider 可以直接读取当前授权账号中已有的 Strava 路线，不再要求用户先从 Strava 下载 GPX、再手动导入 Rider。

## 用户流程

1. 进入“实时骑行设置 → 我的路线 → Strava 路线”。
2. 页面先读取本地目录缓存，不会自动访问 Strava。
3. 需要最新目录时点击“刷新最新路线”。
4. 选择路线并点击“导入并使用”。
5. Rider 获取 Strava 导出的 GPX，解析坐标与海拔，显示在独立的当前路线预览中。
6. 导入结果自动保存到本地路线库，之后可离线加载。

首次启用路线导入，或从旧版本升级后，需要重新连接一次 Strava，授权
`read,read_all,activity:read_all,activity:write`。仅有活动读写权限的旧 Token 不能完整读取路线，
尤其是私有路线及其 GPX。

## 职责边界

- Python 后端独占 Strava OAuth 凭据，负责路线列表和 GPX 请求。
- Python 将手动刷新的路线摘要目录持久化到 `data/cache/strava-routes.json`；GET 只读缓存，POST refresh 才访问 Strava。
- Node 只做同源 HTTP 代理，不读取或保存 Strava Token。
- 浏览器复用现有 GPX 解析和运行时路线构建，路线来源标记为 `strava`。
- 本地路线库保存 Strava Route ID、原始 GPX 和运行时路线，后续骑行不依赖 Strava 在线可用。

## 当前限制

- 当前读取最近最多 100 条 Strava 路线，暂未提供翻页。
- 当前不合并或自动替换与 Strava 路线相似的本地路线。
- Rider 只读取和导入已有路线，不通过 Strava API 创建或修改路线。
- Strava 授权失效或网络不可用时，已经导入到本地路线库的路线仍可使用。
