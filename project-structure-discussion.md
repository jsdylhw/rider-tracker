# Rider Tracker 项目结构讨论整理

## 1. 讨论目的

本文档用于整理目前对项目结构、模块边界、启动器职责、后续扩展方向的讨论结果，作为后续重构和继续开发的参考。

当前项目已经不再是单一页面原型，而是逐步演进为一个具备以下能力的虚拟骑行系统原型：

- 用户参数配置
- 手工路线与 GPX 导入
- 路线坡度与物理模拟
- 蓝牙心率带与功率计接入
- 实时骑行会话
- 真实地图与位置联动
- FIT / JSON 导出
- 后续云服务与平台上传扩展

因此，目录结构和模块职责需要从“原型堆功能”转向“按业务边界组织”。

---

## 2. 对当前结构的总体判断

当前项目已经有了初步分层：

- `app`
- `domain`
- `adapters`
- `ui`
- `shared`

这个方向是正确的，但还不够细，主要问题在于：

- `bootstrap.js` 承担了过多业务职责
- `main-view.js` 过大，UI 逻辑过于集中
- 模拟会话与实时骑行会话存在平行实现
- route 模型还在兼容多种来源，边界不够清晰
- 导出、设备、地图、训练模式尚未形成独立 service 边界

换句话说：

> 当前结构适合继续验证原型，但如果不尽快按模块边界拆分，后面每增加一个功能，复杂度都会明显上升。

---

## 3. 当前项目应抽象出的一级业务模块

根据讨论，整个系统建议收敛为 6 个一级业务模块：

### 3.1 用户数据模块

负责：

- 体重
- FTP
- 最大心率
- 静息心率
- 用户偏好
- 后续账号与云同步配置

### 3.2 路线加载模块

负责：

- 手工设置模拟线路
- GPX 导入
- 路线标准化
- 距离 / 海拔 / 坡度 / 经纬度生成
- 后续路线库与地图选路

### 3.3 训练选择模块

负责：

- 自由骑行
- ERG
- 坡度模拟
- 自定义功率课程

它本质上是训练控制策略层。

### 3.4 设备连接模块

负责：

- 心率带
- 功率计
- trainer / FTMS
- 模拟输入源
- 多数据源切换与优先级

### 3.5 实时骑行模块

负责：

- 开始/停止骑行
- 暂停/恢复
- 定时推进
- 路线位置推进
- 地图 marker 更新
- 会话记录
- 指标计算

### 3.6 导出与平台集成模块

负责：

- JSON 导出
- FIT 导出
- 后续云同步
- 三方平台上传

---

## 4. bootstrap 的正确职责

讨论结论：

`bootstrap` 应该负责模块的**启动、装配和初始化**，不应该承担具体业务实现。

### 4.1 bootstrap 应该负责

- 创建 store
- 创建各 service
- 创建各 adapter
- 创建 view
- 注入依赖
- 恢复初始状态
- 启动初始化流程

### 4.2 bootstrap 不应该负责

- GPX 导入后的 route 构建细节
- 实时骑行推进规则
- 设备断连后的业务决策
- FIT 导出字段拼装
- ERG / 坡度模拟策略
- trainer 能力判断

一句话总结：

> bootstrap 应该是“启动器 / 装配器”，而不是“业务总控文件”。

---

## 5. 推荐的分层方式

建议整个项目按下面 5 层组织：

### 5.1 `app`

职责：

- 应用启动
- 模块装配
- 状态编排
- service 调用

### 5.2 `domain`

职责：

- 纯业务逻辑
- 路线模型
- 会话模型
- 物理模型
- 指标计算

要求：

- 尽量不直接依赖 DOM
- 不直接依赖浏览器 BLE
- 不直接依赖地图框架

### 5.3 `adapters`

职责：

- 对外部能力做适配
- BLE
- 地图框架
- FIT 导出
- 本地存储
- 云 API
- 第三方平台

### 5.4 `ui`

职责：

- 页面
- 组件
- 地图展示
- 图表
- dashboard
- PiP

### 5.5 `shared`

职责：

- 公共格式化
- 数学与地理工具
- 常量
- 公共类型

---

## 6. 推荐的目录结构

讨论建议最终朝下面结构演进：

```text
rider-tracker/
├── public/
│   ├── assets/
│   ├── icons/
│   └── mock/
├── src/
│   ├── app/
│   │   ├── bootstrap.js
│   │   ├── app-config.js
│   │   ├── dependency-container.js
│   │   ├── store/
│   │   │   ├── app-store.js
│   │   │   ├── initial-state.js
│   │   │   └── reducers/
│   │   └── services/
│   │       ├── app-init-service.js
│   │       ├── user-service.js
│   │       ├── route-service.js
│   │       ├── workout-service.js
│   │       ├── device-service.js
│   │       ├── ride-service.js
│   │       └── export-service.js
│   ├── domain/
│   │   ├── user/
│   │   ├── route/
│   │   ├── workout/
│   │   ├── physics/
│   │   ├── ride/
│   │   └── export/
│   ├── adapters/
│   │   ├── bluetooth/
│   │   ├── storage/
│   │   ├── export/
│   │   ├── maps/
│   │   ├── cloud/
│   │   └── platform/
│   ├── ui/
│   │   ├── pages/
│   │   ├── renderers/
│   │   ├── map/
│   │   ├── pip/
│   │   ├── charts/
│   │   └── components/
│   ├── shared/
│   │   ├── format/
│   │   ├── utils/
│   │   ├── constants/
│   │   └── types/
│   └── styles/
├── docs/
├── tests/
├── index.html
└── README.md
```

---

## 7. 更适合当前仓库的中期结构

考虑到当前项目已经有较多代码，直接一步重构到最终版成本较高，因此更建议先演进到下面这个“中期结构”：

```text
src/
  app/
    bootstrap.js
    store/
      app-store.js
    services/
      route-service.js
      ride-service.js
      device-service.js
      export-service.js

  domain/
    course/
      gpx-parser.js
      route-builder.js
      route-sampler.js
    physics/
      cycling-model.js
    ride/
      simulator.js
      live-ride-session.js
      ride-summary.js

  adapters/
    bluetooth/
      heart-rate-monitor.js
      power-meter.js
    export/
      fit-exporter.js
    storage/
      session-storage.js

  ui/
    renderers/
      main-view.js
      route-renderer.js
      simulation-renderer.js
      live-ride-renderer.js
    map/
      map-controller.js
      route-layer.js
      marker-layer.js

  shared/
    format/
      format.js
    utils/
      geo.js
      math.js
```

这个版本最适合当前项目逐步迁移。

---

## 8. 当前文件后续建议归位

### 8.1 `bootstrap.js`

建议保留在：

- `src/app/bootstrap.js`

但应逐步只保留：

- 初始化
- 装配
- service 调用入口

### 8.2 `main-view.js`

建议继续保留在：

- `src/ui/renderers/main-view.js`

但应逐步拆成：

- `route-renderer.js`
- `simulation-renderer.js`
- `live-ride-renderer.js`
- `dashboard-renderer.js`
- `export-renderer.js`

### 8.3 `domain/course`

建议继续拆：

- `gpx-parser.js`
- `route-builder.js`
- `route-sampler.js`
- `route-model.js`

### 8.4 `domain/session`

建议统一成：

- 共享 record 模型
- 共享 summary 逻辑
- 会话工厂

### 8.5 `domain/physics`

建议后续继续拆：

- `speed-solver.js`
- `heart-rate-model.js`
- `environment-model.js`

### 8.6 `adapters/bluetooth`

建议后续增加：

- `trainer-ftms.js`
- `device-registry.js`
- `data-source-selector.js`

### 8.7 `adapters/export`

建议后续拆：

- `fit-exporter.js`
- `json-exporter.js`
- `fit-mapper.js`

### 8.8 `ui/map`

建议后续拆：

- `map-controller.js`
- `route-layer.js`
- `ride-progress-layer.js`
- `marker-layer.js`
- `provider-registry.js`

---

## 9. 当前最优先的重构方向

根据讨论，当前最建议优先处理的是：

### 第一优先级

- `ride-service`
- `route-service`

原因：

- 一个是运行时核心
- 一个是路线数据核心

### 第二优先级

- `device-service`

原因：

- 后续 FTMS、模拟输入源、多设备优先级切换都会放大这里的复杂度

### 第三优先级

- `workout-service`

原因：

- 未来明确要支持：
  - 自由骑行
  - ERG
  - 坡度模拟
  - 自定义功率课程

### 第四优先级

- `export-service`
- `user-service`

---

## 10. 一步到位的重构步骤

考虑到当前项目代码规模还不算大，可以直接做“一步到位”的结构重构，而不是长期停留在中期结构。建议按下面顺序执行，一次性把目录、模块边界、状态结构和主流程收敛好。

### 10.1 第一步：先重建目录骨架

先把目标目录创建出来：

```text
src/
  app/
    bootstrap.js
    app-config.js
    dependency-container.js
    store/
      app-store.js
      initial-state.js
    services/
      app-init-service.js
      user-service.js
      route-service.js
      workout-service.js
      device-service.js
      ride-service.js
      export-service.js

  domain/
    user/
    route/
    workout/
    physics/
    ride/
    export/

  adapters/
    bluetooth/
    storage/
    export/
    maps/
    cloud/
    platform/

  ui/
    pages/
    renderers/
    map/
    pip/
    charts/
    components/

  shared/
    format/
    utils/
    constants/
    types/
```

目的：

- 先把边界搭出来
- 后续迁移文件时不需要反复改目录

### 10.2 第二步：先拆 `bootstrap.js`

这是整个重构的核心入口。

当前 `bootstrap.js` 中的逻辑建议按下面方式迁出：

- 用户初始化相关 -> `app/services/app-init-service.js`
- 路线相关 -> `app/services/route-service.js`
- 训练模式相关 -> `app/services/workout-service.js`
- 蓝牙设备相关 -> `app/services/device-service.js`
- 实时骑行相关 -> `app/services/ride-service.js`
- 导出相关 -> `app/services/export-service.js`

重构完成后，`bootstrap.js` 只保留：

- 创建 store
- 创建各 service / adapter / controller
- 注入依赖
- 创建 view
- 启动初始化流程

目标：

- `bootstrap.js` 从“业务控制器”变为“应用启动器”

### 10.3 第三步：统一状态结构

当前状态建议一步切到按模块组织的结构：

```js
state = {
  user: {},
  route: {},
  workout: {},
  devices: {},
  ride: {},
  export: {},
  ui: {}
}
```

各块职责建议如下：

- `user`
  - 用户资料
  - FTP / 体重 / 心率参数
  - 偏好设置
- `route`
  - 当前路线
  - 路线来源
  - 路线段
  - GPX 元数据
- `workout`
  - 当前训练模式
  - ERG / 自由骑行 / 坡度模拟 / 自定义课程配置
- `devices`
  - 心率带
  - 功率计
  - trainer
  - 模拟输入源
- `ride`
  - 实时骑行会话
  - 模拟会话
  - dashboard 状态
- `export`
  - FIT / JSON 导出配置
  - 三方平台上传状态
- `ui`
  - 页面模式
  - 弹窗
  - PiP
  - 提示信息

### 10.4 第四步：重构 domain 层

把当前领域逻辑一步归位：

#### `domain/route/`

建议收敛为：

- `gpx-parser.js`
- `route-builder.js`
- `route-sampler.js`
- `route-model.js`
- `elevation-utils.js`

职责：

- GPX 解析
- 路线标准化
- 路线采样
- 经纬度 / 海拔 / 坡度 / 距离模型

#### `domain/physics/`

建议收敛为：

- `cycling-model.js`
- `speed-solver.js`
- `heart-rate-model.js`
- `environment-model.js`

职责：

- 功率 -> 速度
- 阻力模型
- 心率模型
- 环境参数

#### `domain/ride/`

建议收敛为：

- `ride-session.js`
- `simulator.js`
- `live-ride-session.js`
- `ride-record.js`
- `ride-summary.js`
- `metrics/`
  - `tss.js`
  - `np.js`
  - `if.js`
  - `zones.js`

重点：

- 模拟会话和实时骑行会话共用统一的 record schema
- summary 逻辑统一
- 指标计算从 session 逻辑中拆开

#### `domain/workout/`

建议新增：

- `workout-mode.js`
- `free-ride-mode.js`
- `erg-mode.js`
- `grade-sim-mode.js`
- `custom-workout-mode.js`

目的：

- 明确训练模式层
- 不再把训练策略混进骑行会话逻辑

### 10.5 第五步：重构 adapters 层

#### `adapters/bluetooth/`

建议组织为：

- `heart-rate-monitor.js`
- `power-meter.js`
- `trainer-ftms.js`
- `ble-device-factory.js`
- `data-source-selector.js`

目的：

- 后续接 trainer
- 统一设备能力探测
- 管理真实输入源和模拟输入源

#### `adapters/storage/`

建议组织为：

- `session-storage.js`
- `route-storage.js`
- `user-storage.js`

#### `adapters/export/`

建议组织为：

- `fit-exporter.js`
- `json-exporter.js`
- `csv-exporter.js`
- `fit-mapper.js`

#### `adapters/maps/`

建议组织为：

- `leaflet-map-adapter.js`
- `map-provider-registry.js`

#### `adapters/cloud/`

即使现在还没做云服务，也建议把壳先留好：

- `api-client.js`
- `activity-api.js`
- `route-api.js`
- `auth-api.js`

#### `adapters/platform/`

预留三方平台：

- `strava-client.js`
- `garmin-client.js`
- `trainingpeaks-client.js`

### 10.6 第六步：重构 UI 层

当前 `main-view.js` 过大，建议一步拆为：

#### `ui/pages/`

- `home-page.js`
- `simulation-page.js`
- `live-page.js`
- `history-page.js`

#### `ui/renderers/`

- `main-view.js`
- `route-renderer.js`
- `simulation-renderer.js`
- `live-ride-renderer.js`
- `dashboard-renderer.js`
- `metrics-renderer.js`
- `export-renderer.js`

#### `ui/map/`

- `map-controller.js`
- `route-layer.js`
- `marker-layer.js`
- `progress-layer.js`
- `provider-selector.js`

#### `ui/pip/`

- `pip-controller.js`

说明：

- 这里也意味着把根目录下的 `pip.js` 收回到 `src/ui/pip/`
- 让 UI 相关代码全部回到 `src/ui/` 内部

#### `ui/components/`

- `metric-card.js`
- `route-table.js`
- `file-importer.js`
- `status-banner.js`

### 10.7 第七步：重构样式目录

当前单一 `style.css` 建议一步拆为：

- `styles/base.css`
- `styles/layout.css`
- `styles/components.css`
- `styles/pages.css`
- `styles/dashboard.css`
- `styles/map.css`

目的：

- 页面结构、组件样式、地图样式、骑行界面样式分离

### 10.8 第八步：测试同步迁移

在“一步到位”重构过程中，测试也应同步按新结构迁移：

- `tests/unit/domain/`
- `tests/unit/services/`
- `tests/unit/adapters/`
- `tests/integration/`
- `tests/fixtures/`

建议：

- 先保留现有测试覆盖的纯业务层
- 重构后为 `route-service`、`ride-service`、`device-service` 增加 service 层测试
- 后续补 integration 测试，覆盖：
  - GPX 导入 -> route 构建
  - 开始骑行 -> 会话推进
  - FIT 导出 -> 数据结构映射

### 10.9 第九步：最后统一入口与引用

当目录迁移基本完成后，再统一做这一步：

- 更新 `index.html` 入口
- 更新 import 路径
- 删除旧位置的临时文件
- 清理重复逻辑
- 补齐文档

建议这一步放到最后做，避免前面迁移阶段一直反复改入口。

---

## 11. 一步到位重构的执行顺序建议

如果真的要一步到位，建议按下面顺序执行：

1. 建目录骨架
2. 拆 `bootstrap.js`
3. 切换 store 结构
4. 收敛 `domain/route`
5. 收敛 `domain/ride`
6. 收敛 `domain/physics`
7. 新建 `workout-service` 与 `domain/workout`
8. 重构 `adapters`
9. 拆 `main-view.js`
10. 把 `pip.js` 收回 `ui/pip/`
11. 拆样式
12. 迁移测试
13. 清理旧文件与文档

---

## 12. 一步到位重构的注意事项

### 12.1 统一数据模型优先于拆文件

比起先拆文件名，更重要的是先统一这些核心模型：

- route model
- ride record
- ride summary
- device state
- workout mode

如果模型没统一，只是挪文件，复杂度不会真正下降。

### 12.2 bootstrap 要最后“瘦身”

不要一开始就只删 `bootstrap.js` 代码，正确顺序是：

- 先把逻辑迁到 service
- 再让 bootstrap 只保留装配

### 12.3 UI 重构要防止和业务逻辑反复缠绕

UI 层迁移时应坚持：

- renderer 只渲染
- service 负责业务动作
- domain 负责计算

### 12.4 保持适配层边界清晰

这些依赖后面都很可能变化：

- 地图源
- BLE 设备
- FIT 导出方式
- 云 API

所以必须放在 `adapters`，避免再次渗透回业务层。

---

## 13. 如果按一步到位重构，最终目标是什么

最终目标不是“目录更漂亮”，而是得到下面这种结构特征：

- `bootstrap.js` 很薄
- `main-view.js` 很薄
- service 层明确
- route / ride / workout / devices / export 各自独立
- domain 层纯粹
- adapters 层可替换
- UI 层只负责展示
- 测试可以围绕模块边界写

也就是说，最终应该把项目从：

> 原型功能集合

推进到：

> 具备清晰模块边界的虚拟骑行应用骨架

---

## 14. 推荐的状态结构

后续 store 更合理的组织方式是：

```js
state = {
  user: {},
  route: {},
  workout: {},
  devices: {},
  ride: {},
  export: {},
  ui: {}
}
```

比当前更清晰的原因：

- 谁的数据归谁
- 谁的 action 修改谁
- 更容易做模块边界
- 更适合后续接云服务

---

## 15. 一句话总结

整个项目的最佳目录组织方式应当是：

- `app` 管编排
- `domain` 管业务
- `adapters` 管外部依赖
- `ui` 管页面与展示
- `shared` 管公共工具

而 `bootstrap` 的角色应收敛为：

> 模块启动器、装配器、初始化协调器

而不是继续承担：

> 路线控制器 + 设备控制器 + 骑行引擎 + 导出控制器 + UI 控制器

这也是后续项目继续稳定扩展的关键。
