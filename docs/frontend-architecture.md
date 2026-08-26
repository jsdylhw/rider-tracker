# Rider 前端视图边界

本文重点说明 View、renderer 和页面 DOM 的边界。`src/domain`、`src/app`、`src/adapters`
与 `src/ui` 的整体依赖方向和代码归属规则见 [`source-architecture.md`](./source-architecture.md)。

## 目标

前端继续使用原生 ES Modules，不引入新框架。页面结构按业务能力拆分，同时保留 `createLiveView()` 作为 `main-view` 的稳定门面，避免一次重构同时改动所有 renderer。

## 骑行页面视图

`src/ui/views/live-view.js` 只负责组合以下视图，不再直接维护整页 DOM：

- `RouteWorkspaceView`：路线来源、路线库、AI 候选、地图选点、GPX 和路线预览。
- `PreRideSetupView`：功率来源、debug 模拟输入、控制模式和 ERG 课程设置。
- `DeviceSetupView`：心率带、功率计、骑行台的连接入口和设备状态。
- `RideReadinessView`：进入骑行界面入口、阻塞原因和当前路线/控制状态。
- `LiveRideDashboard`：骑行开始/停止、实时指标、地图、街景、海拔和 PiP 控件。

各视图拥有自己的 DOM 查询和直接交互事件。现有 renderer 暂时继续消费扁平的 `elements` 对象；后续可以逐个 renderer 改成只接收对应 View，不需要再次改页面 DOM。

## Dashboard renderer

`dashboard-renderer.js` 保留实时状态投影和沉浸街景状态机，以下职责已下沉：

- `dashboard/dashboard-metric-customizer.js`：实时指标的添加、移除和选择状态。
- `dashboard/dashboard-route-presentation.js`：当前位置、探索转向控件、地图显隐和海拔标题。
- `dashboard/ride-alert-presenter.js`：半程及终点提醒的 DOM 生命周期。

地图/街景同步、训练目标图和指标渲染已经分别由既有 controller/renderer 承担。下一步若继续拆分，应优先提取沉浸街景状态机，不要把实时 store 订阅重新塞回 DOM View。

路线文字讲解也是独立子系统：`route-narration-service.js` 管理用户确认、路线身份、异步准备和本次骑行内存缓存，
`narration-timeline.js` 进行本地里程匹配，`route-narration-renderer.js` 只维护街景 HUD 右侧卡片。
它只在用户点击“加载讲解”后请求独立 RouteNarrationAgent，并复用实时骑行的 `distanceKm`；它不写入 `street-view-controller.js`，也不进入 FTMS 控制循环。
详细契约与后续地点检索/TTS 边界见 [`route-narration.md`](./route-narration.md)。

## 首页 Agent

首页右下角 Agent 浮窗是活动分析与训练建议的通用入口，只在首页显示。它通过
`personal-fit-agent-client.js` 请求 Rider Node，再由 Node 代理到内置 Python Training Agent；
不在浏览器中复制活动查询或分析逻辑。

- 首页对话使用独立的本地 session key，避免与“AI 路线”页面互相污染上下文。
- “清除上下文”会同时轮换 session ID，并清空当前回答和结构化结果。
- 回答正文显示在对话区；`metric_cards`、`table`、`line_chart` 和 `markdown`
  presentation 显示在浮窗工作区。
- Agent 回答与 Markdown presentation 共用 `safe-markdown-renderer.js`。它只用 DOM 节点和
  `textContent` 渲染标题、段落、列表、表格、粗体及代码，不接受模型输出中的原始 HTML、图片或链接。
- 训练历史 presentation 按“确定性总结、趋势对比表、周期曲线”展示；总结直接来自
  `training_history_analysis.v1` 的结论、警告和下一步检查，不由前端重新解释指标。
- 路线请求仍引导到“实时骑行设置 → AI 路线”，候选选择、地图预览和最终确认不塞进首页小浮窗。
- Agent 请求期间禁止重复发送；晚到的旧请求结果不会覆盖清除上下文后的新会话。

## DOM 与 CSS 约束

- 设备设置 DOM 直接位于骑行前页面，禁止启动后使用 `append()` 把 Dashboard 子树搬到其他区域。
- 不保留不可见的旧数据节点或旧 radio 作为兼容接口；renderer 只写入实际展示的 DOM。
- 首页使用 `.home-content-grid`，骑行设置使用 `.live-setup-grid`，不再使用全局 `.layout-grid`。
- 骑行前布局和设备状态样式位于 `pre-ride-setup.css`；Dashboard 样式继续位于 `ride-dashboard.css` 和 `immersive-street-view.css`。
- 新 CSS 应以功能域类名为入口，避免依赖页面中偶然的父子位置。

## 尚未完成

- `index.html` 仍包含完整静态标记。当前没有把 HTML 改成字符串模板，是为了保持首屏结构、可访问性和现有测试稳定；后续可按页面拆成构建期 partial，而不是在运行时拼接大段 HTML。
- `main-view.js` 仍集中订阅 store。应在路线、骑行和活动边界稳定后，逐步下沉到 page controller。
- `forms-actions.css` 仍较大，需要按路线表单、训练设置和通用控件继续拆分。
- 浏览器手工验收仍需覆盖路线生成/切换、debug 模拟功率、设备按钮、Dashboard 开始/停止和沉浸街景。
