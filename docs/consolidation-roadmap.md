# Rider 与 Training Agent 结构整理路线

## 目标

在继续增加 AI 训练建议、ERG 课表和实时分析能力之前，先稳定三条公共边界：

1. 一个活动身份和一套可验证的 FIT 派生数据契约。
2. 路线草稿、确认路线和可骑行路线之间明确的持久化转换。
3. 一个统一的 Rider 页面外壳，Agent 作为能力入口而不是第二套产品界面。

本轮只记录整理方向。活动工作流的恢复、重试和状态机结构后续单独分析。

## 当前结构

### FIT 处理

当前不是两个数据库，而是同一数据库之上存在两套 FIT 解析用途：

- Rider JavaScript `fit-importer` 在浏览器或 Node 侧把 FIT 转成 `session`、records、路线和页面指标。
- Training Agent Python `fit.parser` 解析更完整的 FIT 消息，用于 `activity_facts`、专项分析、报告和精确区间查询。
- 两边已共用 `activities.fit_file_path` 和稳定活动 ID，但 records、运动员参数、指标命名和缺失值规则仍可能漂移。

因此问题不是立即删除某一个解析器，而是缺少一个明确的活动导入契约和跨实现一致性测试。

### 路线

目前至少存在四种不同生命周期的数据：

- `route_plans` / `route_plan_revisions`：Agent 生成的候选、当前选择、语义修改和撤销历史。
- 浏览器 `agent-route-draft`：当前 Agent 草稿的本地镜像，用于刷新后快速恢复。
- Rider store 中的 route：当前地图预览或即将执行的运行时路线。
- `saved_routes`：数据库中遗留的可复用路线库表，目前尚未接回当前分支的产品链路。

Agent 草稿已经要求最终确认，但“确认”还没有成为稳定的 `saved_routes` 写入动作，因此确认后的路线仍不等于用户路线库中的长期资产。

### 前端

当前主页面已经有 Home、Live、Activity Detail 等模式，也拆出了 renderer、view 和 service；但 `main-view` 仍集中组装大量 DOM 元素、订阅和功能控制。活动详情、路线规划、实时骑行和全局 Agent 的布局规则还没有形成统一页面外壳。

## 推荐实施顺序

### 第一阶段：统一 FIT 处理边界

这是优先级最高的一块，因为活动详情、历史分析、训练建议和后续实时反馈都依赖它。

建议先完成：

1. 定义 `ActivityIngestionResult`，至少固定 `activity_id`、source、FIT path、运动类型、开始时间、摘要指标、运动员参数来源和数据质量信息。
2. 明确原始 FIT 是不可变事实源；`activity_facts` 是可重建的确定性派生物；`activity_reports` 是模型派生物。
3. Garmin 下载、网页 FIT 导入和骑行结束生成 FIT，最终都进入同一个“保存文件 → upsert activity → 生成 facts”入口。
4. 暂时保留 JS 和 Python 解析器：JS 负责即时导入体验，Python 负责完整事实和分析；用同一批 FIT fixture 校验距离、时长、功率、心率、GPS、FTP 和心率设定等公共字段。
5. 页面优先读取数据库中的活动身份和事实；只有绘制完整秒级曲线时才读取原始 FIT，避免每层自行推导摘要。

完成标准：同一 FIT 从 Garmin、网页导入或本地索引进入后，只产生一个活动；Node/Python 公共指标在约定容差内一致；缺失 FTP/心率的来源能够解释。

### 第二阶段：接通路线保存

FIT 边界稳定后再处理路线资产，范围相对独立，也能为前端统一提供稳定接口。

建议定义三个状态：

```text
Agent RoutePlan draft -> confirmed candidate -> Rider SavedRoute -> Ride runtime snapshot
```

具体工作：

1. 给 `saved_routes` 建立正式 repository 和 API，不让页面直接写 SQLite。
2. 确认 Agent 候选时执行显式 `save_confirmed_route`，保存几何、名称、来源、距离、是否有海拔、Agent plan/candidate 关联信息和指纹。
3. GPX 导入、地图选点、AI 路线最终都转换成同一个 `SavedRoute` 契约。
4. 浏览器 localStorage 只保存未确认草稿或缓存键，不再作为已确认路线的事实源。
5. 开始骑行时从 `SavedRoute` 创建不可变 runtime snapshot；后续编辑路线不会改变已经开始的骑行。

AI 虚拟路线继续允许无海拔并配合 ERG；GPX/Strava 路线可以携带海拔。二者使用同一保存模型，但不能伪造坡度数据。

完成标准：确认后的 AI/GPX/地图路线都能在路线库重新打开、骑行和删除；刷新或重启不依赖原聊天会话；重复导入由几何指纹处理。

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

下一轮只做第一阶段的设计与最小实现：列出 JS/Python FIT 公共字段映射，选择 3 至 5 个真实 fixture 建立一致性测试，再决定哪些解析结果需要持久化。不要同时开始路线库或页面重构。
