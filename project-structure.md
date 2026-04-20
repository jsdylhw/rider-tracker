# Rider Tracker 项目结构总结（按当前代码）

## 项目定位
`rider-tracker` 是一个基于 Web 的虚拟骑行应用，当前核心能力已覆盖：

- 单页多视图：`home / simulation / live`
- 手工分段路线 + GPX 导入 + 坡度/海拔处理
- 模拟骑行与实时虚拟骑行
- 蓝牙设备接入：心率带、功率计、骑行台 FTMS
- 训练模式：自由骑行（固定阻力）/ 固定功率（ERG）/ 坡度模拟（SIM）
- 沉浸街景（Google Street View）+ 双缓冲抗黑屏
- PiP 悬浮窗
- JSON / FIT 导出、FIT 上传端点适配

当前采用 **单入口 + 分层模块化**：

- 单入口：`index.html`
- 应用编排：`src/app`
- 领域逻辑：`src/domain`
- 外部适配：`src/adapters`
- UI 与渲染：`src/ui`
- 公共工具：`src/shared`

---

## 根目录结构（关键）
- `index.html`
  - 唯一页面入口，承载所有视图 DOM
- `style.css`
  - 全局样式（当前仍为单文件）
- `README.md`
  - 使用说明与功能文档
- `log.md`
  - 迭代变更记录
- `project-structure.md`
  - 本文档
- `tests/`
  - 单元/集成测试、测试夹具 GPX、测试运行器
- `street-view-demo.html`
  - 独立街景示例页
- `powertest/`
  - BLE 功率/FTMS 相关独立验证页
- `server/`
  - 服务端示例（Strava token / 上传相关）

> 说明：根目录当前没有固定的示例 GPX 文件；测试 GPX 样本位于 `tests/gpx/`。

---

## `src` 分层说明

### `src/app`
负责应用启动、状态装配、service 编排。

- `bootstrap.js`
  - 应用启动入口，装配 store / service / renderer
- `store/`
  - `app-store.js`：全局 store
  - `initial-state.js`：初始状态与全局配置（包含街景更新周期）

#### `src/app/services`
- `ui-service.js`
  - 视图模式切换、Dashboard 开关
- `user-service.js`
  - 参数更新与持久化写回
- `route-service.js`
  - 路线增删改、GPX 导入、路线重建
- `ride-service.js`
  - 模拟骑行与实时骑行主循环、开始/停止、自动导出触发
- `device-service.js`
  - 蓝牙设备连接编排（心率/功率/trainer）
- `workout-service.js`
  - 训练模式切换、控制命令生成
- `export-service.js`
  - JSON/FIT 导出与上传能力编排

---

### `src/domain`
负责纯业务逻辑与模型计算。

#### `src/domain/route`
- `gpx-parser.js`
  - GPX 解析、轨迹点提取、坡度/海拔处理
- `route-builder.js`
  - route model 构建与采样（手工段/GPX 统一）

#### `src/domain/ride`
- `simulator.js`
  - 整条路线离线模拟
- `live-ride-session.js`
  - 实时会话推进、记录生成

#### `src/domain/physics`
- `cycling-model.js`
  - 功率-速度-坡度-阻力近似模型

#### `src/domain/workout`
- `workout-mode.js`
  - 模式枚举与标签
- `trainer-command.js`
  - Trainer 控制命令结构
- `resistance-mode.js`
  - 固定阻力模式逻辑
- `erg-mode.js`
  - ERG 目标功率逻辑
- `grade-sim-mode.js`
  - 坡度模拟策略、平滑与阈值控制

---

### `src/adapters`
外部能力适配层。

#### `src/adapters/bluetooth`
- `heart-rate-monitor.js`
  - 心率服务连接与订阅
- `power-meter.js`
  - 功率/踏频多服务融合（CP/CSC/FTMS）
- `trainer-ftms.js`
  - 骑行台 FTMS 指令下发（队列、节流、防拥塞）

#### `src/adapters/export`
- `fit-exporter.js`
  - FIT 组包导出

#### `src/adapters/storage`
- `session-storage.js`
  - 会话本地持久化

#### `src/adapters/upload`
- `fit-upload-client.js`
  - FIT 上传接口适配

---

### `src/ui`
页面渲染与交互层。

#### `src/ui/renderers`
- `main-view.js`
  - UI 装配中心，连接 renderer 与 service
- `layout-coordinator.js`
  - 共享卡片挂载、视图切换协调
- `route-renderer.js`
  - 路线编辑、导入、坡度图渲染
- `device-renderer.js`
  - 设备状态显示
- `workout-renderer.js`
  - 训练模式卡与控制状态
- `dashboard-renderer.js`
  - 骑行 Dashboard、沉浸模式控制、街景入口
- `export-renderer.js`
  - 导出元信息表单渲染

#### `src/ui/map`
- `map-controller.js`
  - 地图/路线同步与街景控制器接入
- `street-view-controller.js`
  - 街景模块（脚本加载、双缓冲、节流、交互暂停、销毁）

#### `src/ui/pip`
- `pip-controller.js`
  - PiP 悬浮窗渲染与指标同步

---

### `src/shared`
- `format.js`
  - 数字/时间格式化
- `utils/common.js`
  - 通用工具函数

---

## 当前核心业务流

### 1. 首页（Home）
- 查看概览信息
- 进入模拟骑行或实时骑行

### 2. 模拟骑行（Simulation）
- 编辑/导入路线
- 调整骑行参数
- 运行离线模拟
- 查看结果并导出 JSON/FIT

### 3. 实时虚拟骑行（Live）
- 导入/切换路线
- 选择训练模式（默认坡度模拟）
- 连接设备（心率/功率/trainer）
- 开始实时骑行
- 可进入沉浸街景（满足“已开始骑行 + API 校验通过”）
- 导出会话/FIT

---

## 当前状态结构（主要块）
- `uiMode`：`home / simulation / live`
- `routeSegments`：手工路线段
- `route`：统一路线对象
- `settings`：用户参数
- `workout`：训练模式与运行时控制状态
- `session`：模拟骑行结果
- `liveRide`：实时骑行状态与实时 session
- `ble`：设备连接状态与实时采样值
- `exportMetadata`：导出元信息
- `pipConfig`：PiP 指标开关

---

## 测试结构（已扩展）
`tests/` 当前包含：

- `unit/`：核心领域与渲染行为单测
- `integration/`：实时流程、街景 UI、回归测试
- `gpx/`：真实 GPX 样本夹具
- `helpers/`：测试框架与 polyfill（含 `DOMParser`、fake-dom）
- `test-runner.js`：统一运行入口

当前已覆盖关键路径：

- GPX 导入与样本解析
- 开始/结束骑行
- 文件重复导入触发
- 街景开关与沉浸进出
- FIT 自动导出触发

---

## 当前结构特点

### 已经成熟的部分
- 分层边界清晰：`app / domain / adapters / ui / shared`
- Trainer FTMS 与街景控制器都已模块化
- 实时骑行与导出链路已可闭环
- 回归测试基础已建立

### 仍需优化的部分
- `index.html` 与 `style.css` 体量偏大
- `main-view.js` 仍承担较重装配职责
- 沉浸模式 UI 与普通 Dashboard 共享大量 DOM，后续可继续解耦

---

## 一句话总结
项目已从“原型验证”进入“可持续迭代”的应用阶段，主线能力已形成闭环：

> 路线 -> 训练模式 -> 设备连接 -> 实时骑行 -> 街景沉浸 -> 导出/上传

接下来重点应放在：页面再解耦、样式拆分、测试继续加深。  
