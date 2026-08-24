# Rider 前端视图边界

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
