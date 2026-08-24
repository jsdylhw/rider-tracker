# Rider 与 Training Agent 结构整理路线

## 目标

在继续增加 AI 训练建议、ERG 课表和实时分析能力之前，先稳定三条公共边界：

1. 一个活动身份和一套可验证的 FIT 派生数据契约。
2. 路线草稿、确认路线和可骑行路线之间明确的持久化转换。
3. 一个统一的 Rider 页面外壳，Agent 作为能力入口而不是第二套产品界面。

本轮只记录整理方向。活动工作流的恢复、重试和状态机结构后续单独分析。

## 当前结构

### FIT 处理

当前已经收敛为一条历史 FIT 权威链路：

- Rider JavaScript 保留实时骑行计算、FIT 导出和页面渲染职责，不再作为历史 FIT 摘要的权威来源。
- Training Agent Python `fit.parser` 统一处理网页导入、骑行结束归档和后续详情读取，生成 `activity_facts` 与 `activity_detail.v1`。
- `activity_artifacts` 缓存有版本、可重建的曲线和地图序列；原始 FIT 仍是不可变事实源。
- Node 只把统一详情契约适配为 Rider 页面所需的 `rawSession`，不再重复解码 FIT。

旧的 JS 历史 FIT importer 及其独立指标推导已删除；FIT SDK loader 继续服务实时骑行归档和 FIT 导出。

### 路线

实时骑行中的坡度与累计爬升已经解耦：坡度继续驱动物理阻力和骑行台控制，累计爬升则按相邻路线海拔采样点的正差累加；没有海拔的 AI 路线仍按平路处理。

路线数据已经按四种生命周期拆开：

- `route_plans` / `route_plan_revisions`：Agent 生成的候选、当前选择、语义修改和撤销历史。
- 浏览器 `agent-route-draft`：当前 Agent 草稿的本地镜像，用于刷新后快速恢复。
- Rider store 中的 route：当前地图预览或即将执行的运行时路线。
- `saved_routes`：经用户确认或导入后可长期复用的路线资产。
- `route_progress`：与路线几何分离的未完成进度，可关联最后一次骑行活动。

Agent 草稿仍不会直接进入路线库；最终确认会写入 `saved_routes`。GPX 导入也会自动入库，地图选择或探索路线可以显式保存。完成活动通过 `saved_route_id` 和路线起止里程关联到实际使用的路线快照。

### 前端

当前主页面已经有 Home、Live、Activity Detail 等模式，也拆出了 renderer、view 和 service；但 `main-view` 仍集中组装大量 DOM 元素、订阅和功能控制。活动详情、路线规划、实时骑行和全局 Agent 的布局规则还没有形成统一页面外壳。

### 已统一的跨模块 owner

- 历史 FIT：Python `fit_loader` 注入数据库运动员档案；JS 只负责实时采集、导出和展示适配。
- 运动员档案：`athlete_profiles` 是 FTP、体重和心率阈值的唯一事实源。
- Strava：Python 持有配置、OAuth Token、刷新、上传与状态查询；Node 只代理浏览器回调。
- 路线：Agent plan/revision、浏览器草稿、Rider runtime 和 saved route 已按生命周期分离。
- 活动：Garmin、网页导入和 Rider 骑行结束统一进入同一 ingestion 与 artifact 链路。

### 骑行准备与设备控制

骑行准备正在收敛到统一 `deriveRideReadiness`。debug 模拟功率只豁免真实设备，不豁免有效路线；正式模式按路线、功率源和 FTMS capability 校验。骑行开始后路线和课表结构锁定，控制模式允许安全热切换。详细契约见 [`ride-readiness-and-control.md`](./ride-readiness-and-control.md)。

## 推荐实施顺序

### 第一阶段：统一 FIT 处理边界

这是优先级最高的一块，因为活动详情、历史分析、训练建议和后续实时反馈都依赖它。

已完成的最小闭环：

1. 定义 `fit_ingestion.v1` 与 `activity_detail.v1`，固定活动身份、摘要指标、运动员参数和有界序列。
2. 明确原始 FIT 是不可变事实源；`activity_facts` 是可重建的确定性派生物；`activity_reports` 是模型派生物。
3. Garmin 下载、网页 FIT 导入和骑行结束生成 FIT，最终都进入同一个“保存文件 → upsert activity → 生成 facts”入口。
4. 网页 FIT 导入和活动详情已改走 Python 权威结果；JS 仅做 Rider 视图字段适配。
5. 页面优先读取数据库事实和 `activity_artifacts`，缓存失效时才重新读取原始 FIT。

剩余验收：补充 Garmin 原生骑行、跑步、Rider 虚拟骑行等真实 fixture 的契约回归，并在浏览器手工确认导入、详情、改名、删除和 Strava 上传。

### 第二阶段：接通路线保存（最小闭环已完成）

FIT 边界稳定后再处理路线资产，范围相对独立，也能为前端统一提供稳定接口。

建议定义三个状态：

```text
Agent RoutePlan draft -> confirmed candidate -> Rider SavedRoute -> Ride runtime snapshot
```

已完成：

1. 给 `saved_routes` 建立正式 repository 和 API，不让页面直接写 SQLite。
2. 确认 Agent 候选时保存几何、名称、来源、距离、是否有海拔、Agent plan/candidate 关联信息和指纹。
3. GPX 导入、地图选点、AI 路线最终都转换成同一个 `SavedRoute` 契约。
4. 浏览器 localStorage 只保存未确认草稿或缓存键，不再作为已确认路线的事实源。
5. 开始骑行时从 `SavedRoute` 创建不可变 runtime snapshot；后续编辑路线不会改变已经开始的骑行。
6. `route_progress` 独立保存中断位置；活动落库后记录 `saved_route_id`、起始里程和结束里程。

AI 虚拟路线继续允许无海拔并配合 ERG；GPX/Strava 路线可以携带海拔。二者使用同一保存模型，但不能伪造坡度数据。

当前完成标准：确认后的 AI 路线和导入的 GPX 会自动入库；地图路线可显式保存；路线能从起点或上次位置重新打开、骑行和删除；刷新或重启不依赖原聊天会话；重复保存由几何指纹处理。

剩余验收：浏览器手工覆盖 AI 确认、地图路线保存、GPX 重复导入、中途停止后继续、骑完整条路线后清除进度。路线识别和历史活动聚类不在本阶段范围内。

### 第三阶段：统一前端外壳

前端放在最后不是因为不重要，而是页面应消费前两阶段已经稳定的活动和路线契约。

建议采用渐进整理，不更换框架：

1. 建立统一 App Shell 和一级导航：主页、骑行、活动、路线；Agent 保持全局入口。
2. AI 路线对话仍放在路线页面；全局 Agent 用于活动分析、训练建议和骑行过程辅助，不复制路线规划页面。
3. 把 `main-view` 中的活动、路线、骑行订阅逐步下沉到各自 page controller；共享地图、状态提示、空态和错误展示组件。
4. 活动详情只消费统一的 activity detail/presentation contract；路线页面只消费 draft/saved/runtime 三种明确状态。
5. 先保证桌面布局，再补响应式尺寸，不在领域契约仍变化时做大规模视觉重写。

完成标准：刷新和跨页面导航不丢当前活动、路线草稿或已确认路线；页面不会出现两套地图或两套 Agent 对话；长活动报告不会撑开整体布局。

## 为什么不是先改前端

如果先重做页面，活动详情仍需兼容两套指标来源，路线页仍不知道应该保存草稿还是最终路线。等数据边界修正后还要再次修改 store、API 和 renderer。先完成 FIT 和路线契约，可以把前端工作限制为稳定接口上的布局与交互整理。

## 建议的下一步

下一轮优先做第三阶段的前端外壳整理，并补第一、二阶段的浏览器真实数据验收；路线识别算法和工作流恢复状态机继续独立排期。
