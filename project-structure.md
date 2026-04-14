# Rider Tracker 项目结构总结

## 项目定位

`rider-tracker` 是一个基于 Web 的虚拟骑行原型，当前已经具备以下核心能力：

- 首页流程与单入口页面切换
- 自定义线路与 GPX 导入
- 路线距离/坡度/海拔处理
- 模拟骑行
- 实时虚拟骑行
- 心率带与功率计连接
- JSON / FIT 导出
- PiP 悬浮窗
- 坡度模拟业务逻辑

当前项目采用的是 **单入口 + 分层模块化** 的结构：

- 单入口：`index.html`
- 应用装配：`src/app`
- 领域逻辑：`src/domain`
- 外部适配：`src/adapters`
- 页面与渲染：`src/ui`
- 通用工具：`src/shared`

---

## 根目录结构

当前根目录关键文件职责如下：

- `index.html`
  - 应用唯一页面入口
  - 承载 `home / simulation / live` 三个视图容器
- `style.css`
  - 全局样式
  - 当前仍是单文件样式表
- `log.md`
  - 记录每轮主要修改内容
- `project-structure.md`
  - 当前文档，整理项目结构
- `ttl.gpx`
  - 用于测试 GPX 导入、海拔和坡度解析
- `tests/`
  - 测试入口、测试工具和单元测试

---

## `src` 分层说明

### `src/app`

负责应用启动、状态装配、service 编排。

当前包含：

- `bootstrap.js`
  - 应用启动入口
  - 创建 store
  - 创建 service
  - 创建主视图与 PiP 控制器
- `store/`
  - `app-store.js`
    - 全局 store
  - `initial-state.js`
    - 初始状态定义

#### `src/app/services`

应用服务层，负责把 UI、状态和领域逻辑串起来：

- `ui-service.js`
  - 页面模式切换
  - PiP 配置
- `user-service.js`
  - 用户参数读写
- `route-service.js`
  - 路线增删改
  - GPX 导入
- `ride-service.js`
  - 模拟骑行
  - 实时骑行主循环
  - 骑行开始/停止
- `device-service.js`
  - 心率带与功率计连接管理
- `export-service.js`
  - 导出会话数据
- `workout-service.js`
  - 训练模式切换
  - 坡度模拟配置更新

---

### `src/domain`

负责纯业务逻辑，是项目最核心的一层。

#### `src/domain/route`

路线相关逻辑：

- `gpx-parser.js`
  - GPX 解析
  - 海拔数据补齐/降级
  - 坡度计算
- `route-builder.js`
  - 构建统一 route model
  - 路线采样
  - 手工路线 / GPX 路线统一封装

#### `src/domain/ride`

骑行会话逻辑：

- `simulator.js`
  - 整条路线模拟
- `live-ride-session.js`
  - 实时骑行会话推进

#### `src/domain/physics`

物理模型：

- `cycling-model.js`
  - 功率、坡度、速度、心率的物理近似计算

#### `src/domain/workout`

训练模式与坡度模拟：

- `workout-mode.js`
  - 训练模式枚举与标签
- `grade-sim-mode.js`
  - 基于当前路线实时梯度生成目标模拟坡度
  - 输出后续可下发给 trainer 的控制命令结构

---

### `src/adapters`

负责和外部能力打交道。

#### `src/adapters/bluetooth`

- `heart-rate-monitor.js`
  - 心率带蓝牙连接
- `power-meter.js`
  - 功率计蓝牙连接

当前默认假设 trainer 适配层还未正式接入。

#### `src/adapters/storage`

- `session-storage.js`
  - 最近一次会话持久化

#### `src/adapters/export`

- `fit-exporter.js`
  - FIT 导出

---

### `src/ui`

负责页面结构、渲染和交互。

#### `src/ui/renderers`

当前已经拆成多个 renderer：

- `main-view.js`
  - 主视图装配器
  - 连接各 renderer
- `layout-coordinator.js`
  - 页面切换
  - 共享卡片布局协调
- `route-renderer.js`
  - 路线卡、路线表格、路线摘要、坡度图
- `device-renderer.js`
  - 设备连接与实时设备状态展示
- `dashboard-renderer.js`
  - 骑行大屏
- `export-renderer.js`
  - 导出信息表单
- `workout-renderer.js`
  - 训练模式卡
  - 坡度模拟参数与状态展示

#### `src/ui/map`

- `map-controller.js`
  - 地图显示与路线同步

#### `src/ui/pip`

- `pip-controller.js`
  - PiP 悬浮窗渲染
  - 当前已改成上下布局：
    - 上：训练数据
    - 下：实时坡度

---

### `src/shared`

通用工具层。

当前包含：

- `format.js`
  - 数字、时间显示格式化
- `utils/common.js`
  - 通用辅助函数

---

## 当前核心业务流

### 1. 首页

首页当前只显示四类信息：

- 项目简介
- 个人数据
- 历史数据
- 两个入口
  - 模拟骑行
  - 虚拟骑行

### 2. 模拟骑行

进入 `simulation` 视图后：

- 选择/导入路线
- 配置模拟参数
- 运行整条路线模拟
- 查看模拟结果
- 导出 JSON / FIT

### 3. 虚拟骑行

进入 `live` 视图后：

- 选择/导入路线
- 查看路线坡度预览
- 选择训练模式
  - 自由骑行
  - 坡度模拟
- 连接设备
  - 心率带
  - 功率计
- 开始实时骑行
- 打开骑行大屏 / PiP
- 导出会话

---

## 当前状态结构

当前全局 state 主要包含这些块：

- `uiMode`
  - `home / simulation / live`
- `routeSegments`
  - 手工路线段数组
- `route`
  - 当前统一路线对象
- `settings`
  - 用户骑行参数
- `workout`
  - 训练模式与坡度模拟配置
- `session`
  - 模拟骑行结果
- `liveRide`
  - 实时骑行状态与会话
- `ble`
  - 心率带/功率计状态
- `exportMetadata`
  - 导出元信息

---

## 当前结构特点

### 已经比较清晰的部分

- 单入口结构已经稳定
- `app / domain / adapters / ui / shared` 分层已经成型
- 路线、实时骑行、训练模式已经开始分模块
- PiP、导出、地图、设备连接已经有相对独立的渲染/适配模块

### 当前仍然偏重的部分

- `index.html`
  - 视图 DOM 较多
- `style.css`
  - 仍是单文件
- `main-view.js`
  - 虽然比之前瘦，但仍是 UI 主装配中心

---

## 当前最关键的业务模块

如果只看当前项目里最关键的几个模块，可以优先关注：

- `src/domain/route/gpx-parser.js`
  - 路线、海拔、坡度数据的核心来源
- `src/domain/ride/live-ride-session.js`
  - 实时骑行推进核心
- `src/app/services/ride-service.js`
  - 运行时编排核心
- `src/domain/workout/grade-sim-mode.js`
  - 坡度模拟策略核心
- `src/ui/renderers/layout-coordinator.js`
  - 单入口页面切换核心

---

## 当前结构下的“坡度模拟”落点

当前坡度模拟逻辑已经放在比较合理的位置：

- 路线实时梯度来源：
  - `src/domain/route/`
- 坡度模拟策略：
  - `src/domain/workout/grade-sim-mode.js`
- 运行时接入：
  - `src/app/services/ride-service.js`
- 页面配置与展示：
  - `src/ui/renderers/workout-renderer.js`

目前还缺的是：

- `trainer-ftms.js`
- 真实 trainer 指令下发

也就是说：

> 当前已经具备“算出该下发什么坡度”的业务能力，下一步只差把命令真正发给骑行台。

---

## 后续建议

如果继续按当前结构演进，建议优先往下做这几件事：

- 新增 `trainer-ftms.js`
  - 接入真实坡度模拟下发
- 拆分 `style.css`
  - 降低样式维护成本
- 继续瘦身 `main-view.js`
  - 让更多交互下沉到 renderer
- 给 `live` 页面补一个 trainer 控制状态卡
  - 可视化 `pendingTrainerCommand`
- 为 GPX 无海拔场景增加更明确的降级提示或高程补全策略

---

## 一句话总结

当前项目已经从原型阶段走到“可持续扩展的应用骨架”阶段：

- `app` 负责装配
- `domain` 负责业务
- `adapters` 负责外部能力
- `ui` 负责页面与渲染

其中最核心的业务主线已经形成：

> 路线 -> 骑行会话 -> 训练模式 -> 设备连接 -> 实时骑行 -> 导出

后续继续演进时，主要工作会集中在：

- trainer 控制接入
- 页面再收敛
- 样式拆分
- 测试完善
