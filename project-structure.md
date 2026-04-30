# Rider Tracker 项目结构总结（按当前代码）

## 项目定位
`rider-tracker` 是一个基于 Web 的虚拟骑行与活动分析应用，核心能力包括：

- 单页多视图：`home / simulation / live / activity-detail`
- 手工分段路线、GPX 导入、路线坡度/海拔处理
- 离线模拟骑行与实时虚拟骑行
- 蓝牙设备接入：心率带、功率计、FTMS 骑行台
- 训练控制：固定阻力、ERG 固定功率、路线坡度模拟、自定义 ERG 目标
- 实时 Dashboard、沉浸街景、PiP 悬浮窗
- JSON / FIT 导出、FIT 本地导入、Strava 上传
- 本地活动历史：sqlite 保存活动摘要，FIT 文件保存在 `data/files/fit/`

当前采用 **单页面 + 本地 Node 服务 + 分层模块化**：

- 页面入口：`index.html`
- 前端应用编排：`src/app`
- 领域逻辑：`src/domain`
- 外部适配：`src/adapters`
- UI 与渲染：`src/ui`
- 本地服务与持久化：`src/server`
- 公共工具：`src/shared`

---

## 根目录结构
- `index.html`
  - 唯一页面入口，承载首页、模拟、实时骑行、活动详情等视图 DOM
- `src/style.css`
  - 样式入口文件，只负责 `@import` 各模块化样式
- `src/styles/`
  - 页面布局、表单动作、活动历史、沉浸街景、Dashboard、响应式等样式模块
- `src/server/index.js`
  - 本地 Node/Express 服务入口，默认端口 `8787`
- `data/`
  - 本地运行数据目录
  - `rider-tracker.db`：sqlite 活动历史数据库
  - `files/fit/`：本地归档 FIT 文件
  - `README.md`：本地数据目录说明
- `README.md`
  - 启动、配置、测试与主要功能说明
- `commit-convention.md`
  - 提交信息与开发记录约定
- `project-structure.md`
  - 当前文件，项目结构说明
- `package.json` / `package-lock.json`
  - Node 服务、测试脚本与依赖（包含 `@garmin/fitsdk`）
- `tests/`
  - 单元/集成测试、测试夹具、测试运行器
- `demos/`
  - 独立示例与实验页

---

## `src/app`
负责应用启动、状态装配、service 编排。

- `bootstrap.js`
  - 创建 store、service、view，并完成页面启动
- `store/app-store.js`
  - 简单全局 store，提供 `getState / setState / subscribe`
- `store/initial-state.js`
  - 初始状态、默认路线、用户参数、导出元信息、实时骑行状态
- `view-models/live-ride-view-model.js`
  - 实时 Dashboard / PiP 所需视图模型

### `src/app/services`
- `ui-service.js`
  - 视图模式切换、活动详情打开、PiP 配置更新
- `user-service.js`
  - 用户参数更新与本地持久化
- `route-service.js`
  - 路线增删改、GPX 导入、路线重建
- `ride-service.js`
  - 模拟骑行、实时骑行开始/停止、结束后活动保存
- `device-service.js`
  - 心率带、功率计、骑行台连接编排
- `workout-service.js`
  - 训练模式切换与训练控制参数更新
- `export-service.js`
  - JSON/FIT 导出、FIT 导入、FIT 本地归档、Strava 上传编排

---

## `src/domain`
负责纯业务逻辑与模型计算，尽量不依赖 DOM 和网络。

### `src/domain/route`
- `gpx-parser.js`
  - GPX 解析、轨迹点提取、坡度/海拔处理
- `route-builder.js`
  - 手工段/GPX 统一 route model 构建与采样

### `src/domain/ride`
- `simulator.js`
  - 离线整条路线模拟
- `live-ride-session.js`
  - 实时 session 推进、当前状态与历史 records 生成

### `src/domain/metrics`
- `ride-metrics.js`
  - 骑行汇总指标：距离、速度、心率、踏频、强度、能量等
- `power-metrics.js`
  - 平均功率、滚动功率、NP、功率窗口等计算

### `src/domain/physics`
- `cycling-model.js`
  - 功率、速度、坡度、阻力的近似物理模型

### `src/domain/physiology`
- `heart-rate-model.js`
  - 心率估算与训练强度相关模型

### `src/domain/workout`
- `workout-mode.js`
  - 训练模式枚举与标签
- `trainer-command.js`
  - 骑行台控制命令结构
- `resistance-mode.js`
  - 固定阻力模式
- `erg-mode.js`
  - ERG 固定功率模式
- `grade-sim-mode.js`
  - 坡度模拟策略、平滑与阈值控制
- `custom-workout-target.js`
  - 自定义 ERG 分段目标

---

## `src/adapters`
外部能力适配层：浏览器 API、FIT SDK、存储接口、上传接口等。

### `src/adapters/bluetooth`
- `heart-rate-monitor.js`
  - 心率服务连接与订阅
- `power-meter.js`
  - 功率/踏频多服务融合（Cycling Power / CSC / FTMS）
- `trainer-ftms.js`
  - FTMS 骑行台指令下发、队列、节流、防拥塞
- `controllable-trainer.js`
  - 可控骑行台抽象封装

### `src/adapters/export`
- `fit-exporter.js`
  - 将 session records 组包成 FIT 文件

### `src/adapters/fit`
- `fit-sdk-loader.js`
  - Garmin FIT SDK 加载入口，本地 `/vendor/@garmin/fitsdk` 优先，CDN 兜底
- `fit-importer.js`
  - FIT 解码并映射成项目内部 session/activity 结构

### `src/adapters/storage`
- `session-storage.js`
  - 最近 session 的浏览器本地持久化
- `activity-history-client.js`
  - 前端访问本地活动历史 API，包括列表、详情、改名、删除、FIT 文件保存/导入

### `src/adapters/upload`
- `strava-server-client.js`
  - 本地 Strava 授权/上传 API 适配
- `fit-upload-client.js`
  - 通用 FIT 上传接口适配

---

## `src/server`
本地 Node/Express 服务层，负责活动历史、FIT 文件、Strava 授权与上传。

- `index.js`
  - Express 启动入口，挂载静态资源、活动路由、Strava 路由
- `activity-store.js`
  - sqlite 活动历史存储
  - 设计方向：数据库保存活动摘要与 `fit_file_path`，FIT 文件作为明细事实源
- `routes/activity-routes.js`
  - 活动列表、详情、改名、删除、FIT 导入、FIT 文件保存接口
  - 详情接口会在有 `fitFilePath` 时从 FIT 文件解析 records
- `routes/strava-routes.js`
  - Strava 授权、连接状态、FIT 上传接口
- `config-store.js` / `token-store.js`
  - 本地 Strava 配置与 token 存储
- `strava-client.js`
  - Strava API 客户端封装
- `pages/`
  - Strava 登录配置页与 OAuth 回调结果页
- `shared/http-utils.js`
  - HTTP 参数、文件名、文本规范化工具

---

## `src/ui`
页面视图、渲染器、地图、PiP 等 UI 层。

### `src/ui/views`
- `home-view.js`
  - 首页模式入口、用户参数表单、历史导入入口
- `simulation-view.js`
  - 模拟骑行视图入口
- `live-view.js`
  - 实时骑行视图入口
- `export-view.js`
  - 导出/导入 FIT 卡片事件绑定
- `activity-detail-view.js`
  - 活动详情页按钮事件

### `src/ui/renderers`
- `main-view.js`
  - UI 装配中心，连接 renderer 与 service
  - 对活动详情做签名缓存，避免重复重建重图表
- `layout-coordinator.js`
  - 共享卡片挂载与视图切换布局协调
- `activity-history-renderer.js`
  - 活动历史列表、详情打开、改名、删除
- `activity-detail-renderer.js`
  - 活动详情汇总、功率/心率图、功率区间、心率区间
  - 图表点位会降采样，完整 records 不丢失
- `route-renderer.js`
  - 路线编辑、导入、坡度图渲染
- `device-renderer.js`
  - 设备连接状态显示
- `workout-renderer.js`
  - 训练模式卡与控制状态
- `custom-workout-target-renderer.js`
  - 自定义 ERG 目标 UI
- `dashboard-renderer.js`
  - 实时 Dashboard、沉浸模式控制、街景入口
- `dashboard-metrics-renderer.js`
  - Dashboard 指标项渲染
- `workout-runtime-renderer.js`
  - 实时训练 runtime 状态展示
- `export-renderer.js`
  - 导出元信息表单渲染
- `svg/`
  - 路线图、session 图、Dashboard 图、通用 ride series chart

### `src/ui/map`
- `map-controller.js`
  - 地图/路线同步与街景控制器接入
- `street-view-controller.js`
  - Google Street View 脚本加载、双缓冲、节流、暂停与销毁

### `src/ui/pip`
- `pip-controller.js`
  - PiP 悬浮窗渲染与指标同步
- `pip-template.js`
  - PiP HTML 模板
- `pip-elevation-chart.js`
  - PiP 海拔/坡度图

---

## `src/shared`
- `format.js`
  - 数字、时间、下载文件等通用格式化/浏览器工具
- `live-metrics.js`
  - 实时指标定义与 Dashboard/PiP 共享指标模型
- `utils/common.js`
  - clamp、文本规范化、错误提取等通用工具

---

## `data`
本地运行数据，不应当作为业务代码提交。

- `data/rider-tracker.db`
  - sqlite 活动历史数据库
  - 主要保存活动摘要、FIT 文件路径、文件大小、更新时间等
- `data/files/fit/`
  - FIT 原始文件归档目录
  - 设计上 FIT 文件是活动明细事实源；详情页可从 FIT 文件重新解析 records
- `data/README.md`
  - 本地数据目录说明

注意：旧版本可能产生数据库记录和 FIT 文件不一致的“孤儿文件”。新逻辑删除活动时会同步删除其 `fitFilePath` 指向的本地 FIT 文件。

---

## 测试结构
`tests/` 当前包含：

- `unit/`
  - domain、adapter、renderer、service、server store 单元测试
- `integration/`
  - 实时流程、GPX 样本、街景 UI、回归测试
- `gpx/`
  - 真实 GPX 样本夹具
- `fixtures/`
  - 通用测试夹具，例如真实 FIT 文件
- `helpers/`
  - 测试框架、DOMParser polyfill、fake DOM
- `test-runner.js`
  - 统一测试入口

当前重点覆盖：

- GPX 导入与路线构建
- 离线模拟与实时骑行推进
- session / records / summary 结构
- 功率、心率、骑行指标计算
- FIT 导出与 FIT 导入
- 活动历史 sqlite 存储
- 活动详情渲染、图表降采样、历史列表交互
- 训练模式与骑行台控制命令
- 街景与 PiP 相关 UI

---

## 当前核心业务流

### 1. 首页（Home）
- 查看用户参数与历史活动
- 从本地导入 FIT
- 进入模拟骑行或实时骑行
- 打开活动详情

### 2. 模拟骑行（Simulation）
- 编辑/导入路线
- 调整骑行参数
- 运行离线模拟
- 查看结果并导出 JSON/FIT

### 3. 实时虚拟骑行（Live）
- 导入/切换路线
- 选择训练模式
- 连接设备（心率/功率/骑行台）
- 开始实时骑行
- 实时显示 Dashboard / PiP / 街景
- 停止后保存活动、归档 FIT、支持上传 Strava

### 4. 活动详情（Activity Detail）
- 历史列表点击详情进入
- 列表只使用数据库摘要
- 详情按需加载完整活动
- 对有 `fitFilePath` 的活动，从 FIT 文件解析 records 并计算/渲染分析结果

---

## 当前状态结构（主要块）
- `uiMode`：`home / simulation / live / activity-detail`
- `routeSegments`：手工路线段
- `route`：统一路线对象
- `settings`：用户基础参数
- `workout`：训练模式与 runtime 控制状态
- `session`：当前/最近完成活动 session
- `selectedActivity`：活动详情页当前活动
- `liveRide`
  - `session`：实时当前状态
  - `records`：实时历史采样序列
  - `summary`：实时汇总指标
- `ble`：设备连接状态与最新设备采样值
- `exportMetadata`：导出与上传元信息
- `pipConfig` / `pipLayout`：PiP 指标与布局

---

## 当前结构特点

### 已经稳定的部分
- 前端分层边界基本清晰：`app / domain / adapters / ui / shared`
- 本地服务已承接活动历史、FIT 文件、Strava 授权上传
- FIT 导入/导出都复用 Garmin FIT SDK
- session 与 records 已从 liveRide 中拆分，实时状态和历史采样职责更清楚
- 活动列表轻量化，详情页按需分析完整记录
- 回归测试覆盖面逐步扩大

### 仍需优化的部分
- `index.html` 仍较大，后续可以继续模板化
- `main-view.js` 仍承担较多 UI 装配职责
- 活动详情 FIT 解析可以增加缓存，避免重复解析大文件
- 长活动 zone/summary 分析可进一步做后台缓存或 worker 化
- 旧历史数据可能仍含 `raw_json` 全量 records，需要迁移/清理策略

---

## 一句话总结
项目已经从“虚拟骑行原型”进入“本地活动记录与分析工具”阶段，主线能力形成闭环：

> 路线 / FIT -> 训练模式 -> 设备连接 -> 实时骑行 -> 活动保存 -> FIT 归档 -> 详情分析 -> Strava 上传

接下来重点应放在：活动存储继续轻量化、详情分析缓存、页面拆分、长期活动性能优化。
