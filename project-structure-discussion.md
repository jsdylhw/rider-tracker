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

## 10. 推荐的状态结构

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

## 11. 一句话总结

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
