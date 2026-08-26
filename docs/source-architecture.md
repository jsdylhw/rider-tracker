# Rider JavaScript 分层与目录职责

## 为什么需要分层

Rider Tracker 同时包含路线、骑行台控制、实时指标、地图、街景、活动分析和 Agent
等能力。分层的目标不是套用固定模板，而是让同一条业务规则只有一个权威实现，并使它可以
脱离页面和外部服务进行测试。

当前 JavaScript 代码采用接近 Clean Architecture、Hexagonal Architecture 和
Ports and Adapters 的轻量分层：

```text
UI（展示和用户输入）
        ↓
App（业务流程编排和运行状态）
        ↓
Domain（纯业务规则、状态转换和计算）
        ↑
Adapters（HTTP、地图、蓝牙、存储等外部能力）
```

这不是所有软件都必须采用的结构。小型原型可以更直接，普通页面也可能只需要
`components / services / api`。Rider 具有实时控制和较多外部集成，业务规则与技术实现
分开后，可以减少 UI、设备控制和数据保存之间互相产生不一致的风险。

## 目录职责

### `src/domain`

领域层是 Rider JavaScript 运行时的业务内核，负责回答“业务上如何计算”和“什么状态才合法”。

当前主要领域包括：

- `metrics`：实时功率和骑行指标。
- `physics`：骑行动力学、阻力和速度模型。
- `ride`：骑行会话、开始条件和模拟过程。
- `route`：路线模型、GPX、坡度、续骑和轨迹处理。
- `workout`：ERG、坡度、阻力模式及骑行台控制命令。
- `narration`：路线讲解契约、路线身份和里程触发时序。

领域代码应尽量保持纯函数或显式状态机，并遵守以下约束：

- 不读写 DOM。
- 不直接发起 HTTP 请求。
- 不直接访问 SQLite、`localStorage` 或文件系统。
- 不依赖具体地图、蓝牙、Agent 或 TTS 实现。
- 相同输入应产生可预测结果，便于直接单元测试。

实时心率是外部传感器观测值，不由 Rider 根据功率在本地推算。没有新鲜心率样本时，
骑行记录使用 `null`；离线和 debug 模拟同样不生成虚构心率。FTP、最大心率和静息心率等
运动员参数仍可用于活动分析和训练区间，但不属于实时心率生成模型。

`domain` 不等同于数据库实体目录。只有稳定且具有业务含义的规则和契约才应放入这里。

### `src/app`

应用层负责完成一次业务用例，将领域规则、外部能力和运行状态组合起来，例如：

- 加载路线讲解计划并管理本次骑行缓存。
- 判断骑行是否可以开始并启动会话。
- 根据控制模式生成指令并交给设备层执行。
- 将地图或 Agent 路线转换成当前运行路线。

`app/services` 可以依赖 `domain` 和注入的 adapter，但不应把 DOM 展示细节变成业务状态。
`app/store` 保存当前应用运行状态，`app/view-models` 将状态投影为 UI 容易消费的数据。

### `src/adapters`

适配器层把外部技术转换为内部可用的数据和操作，当前包括：

- Agent HTTP API。
- Web Bluetooth 和 FTMS。
- Google 地图、海拔及 OSM。
- FIT 导入导出。
- 浏览器存储与上传。
- 路线讲解后端请求；后续本地 TTS 也应从这里接入。

Adapter 可以使用浏览器 API、网络和外部 SDK，但返回值应尽量转换成稳定的内部契约，避免外部
响应格式渗透到 Domain 和 UI。

### `src/ui`

UI 层负责 DOM 查询、事件绑定和结果展示，包括 View、renderer、地图控制器和 Agent 浮窗。
UI 可以把用户输入交给应用服务，也可以展示 Domain 或 view-model 的结果，但不应复制业务规则。

例如，页面可以展示 `deriveRideReadiness` 返回的阻塞原因，但不能另外维护一套“能否开始骑行”
判断，否则页面按钮与真实启动流程可能得出不同结论。

### 其他目录

- `src/server`：Node 服务端接口、代理和数据库边界。
- `src/shared`：没有 Rider 特定业务语义的通用格式化和辅助函数。
- `services/training-agent`：内嵌 Python Training Agent，不属于 `src/domain`；负责 Skill、FIT
  历史分析、路线规划和外部活动工作流。

## 依赖关系示例：路线讲解

路线讲解按以下边界工作：

```text
route-narration-renderer
    显示讲解卡片、按钮和状态
              ↓
route-narration-service
    管理用户确认、异步加载、当前路线和本次骑行缓存
              ↓
narration-plan / narration-timeline
    校验结构化计划并按距离和时间决定当前讲解项
              ↑
route-narration-client
    采样路线并请求后端准备讲解内容
```

- Domain 决定“计划是否合法”和“现在该触发哪条讲解”。
- App 决定“何时加载、是否缓存以及路线切换时如何重置”。
- Adapter 决定“如何请求 Python Agent”；未来也负责“如何调用本地 TTS”。
- UI 决定“文字和播放状态如何显示”。

Python Agent 通过 HTTP 返回结构化计划，JavaScript Domain 对它进行本地校验，而不是直接相信
模型输出。这样更换地点检索平台、模型或 TTS，不需要重写讲解时序规则。

## 新代码放在哪里

增加功能时可以按下面的问题判断：

| 问题 | 推荐位置 |
| --- | --- |
| 是否是纯计算、合法性判断或状态转换？ | `src/domain` |
| 是否在组织多个步骤完成一个用户操作？ | `src/app/services` |
| 是否调用 HTTP、Google、蓝牙、数据库、存储或 TTS？ | `src/adapters` 或 `src/server` |
| 是否操作 DOM、响应点击或渲染内容？ | `src/ui` |
| 是否只是没有业务含义的格式化或通用辅助函数？ | `src/shared` |
| 是否属于活动分析、Skill 或 Python Agent 工具？ | `services/training-agent` |

一个函数同时满足多项时，应先拆出其中稳定的业务规则，再让应用服务调用外部 adapter。例如
“到达 10 km 后调用 TTS”应拆成 Domain 的里程触发判断与 Adapter 的语音合成调用。

## 适度分层原则

分层是为了降低耦合，不是为了增加文件数量。当前项目遵循以下尺度：

1. 同一条关键业务规则只有一个权威实现。
2. 外部 I/O 与可确定性测试的计算分开。
3. UI 不重新解释或计算领域结论。
4. 不为简单函数机械创建 interface、repository 或 use-case 类。
5. 只有真正稳定、可复用且有业务含义的规则才进入 Domain。
6. 优先保持清楚的依赖方向，而不是追求某一种架构术语的完整形式。

判断分层是否有效的简单标准是：核心路线、骑行和讲解规则能否在没有浏览器 DOM、网络与真实设备
的情况下通过单元测试。如果可以，说明业务内核与技术环境基本解耦。
