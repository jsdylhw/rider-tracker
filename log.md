# 变更日志

## 2026-04-14

### 单入口页面结构收紧

- 将 `simulation` 与 `live` 页面里的重复导出区域合并为一个共享导出卡片
- 让共享导出卡片在 `simulation/live` 两个视图之间按 `uiMode` 复用
- 清理 `main-view.js` 中对 `fitExportFormLive`、`downloadSessionBtnLive`、`downloadFitBtnLive` 的重复 DOM 依赖
- 清理 `export-renderer.js` 中对双导出表单的重复同步逻辑
- 清理 `dashboard-renderer.js` 中对旧 live 导出卡片的显隐依赖
- 保持实时骑行进行中隐藏导出卡片，结束后再显示

### 第三轮结构收紧

- 新增 `layout-coordinator.js`，把页面模式切换、共享卡片布局和首页历史摘要展示从 `main-view.js` 下沉
- `main-view.js` 继续瘦身，聚焦主装配与公共渲染流程
- 将根目录 `pip.js` 收回 `src/ui/pip/pip-controller.js`
- 更新 `bootstrap.js` 中的 PiP 引用路径，消除根目录 UI 特例文件

### 首页流程与虚拟骑行入口调整

- 首页改为显示项目简介、个人数据、历史数据和训练线路配置
- 新增“确认线路”流程，确认后隐藏个人数据与历史数据，显示训练模式选择
- 首页路线配置阶段隐藏路线地图，只保留线路编辑和 GPX 导入
- 进入虚拟骑行模式后弹出设备连接层，引导先连接功率计与心率带再开始骑行
- 修正首页路线卡片落位问题，确保 `homeRouteSlot` 真实位于首页视图中
- 将 `live` 页面中的“连接骑行设备”动作与“进入虚拟骑行模式”解耦，避免重复写入页面模式和弹层状态
- 修复设备连接弹层初始被强制显示的问题：为 `.device-modal[hidden]` 增加显式隐藏规则，避免被 `display: flex` 覆盖

### 首页流程再次收口

- 首页调整为只显示项目简介、个人数据、历史数据以及“模拟骑行 / 虚拟骑行”两个入口
- 移除首页上的路线配置、确认线路和模式二次选择流程
- 路线选择下沉到 `simulation` 和 `live` 视图内部
- 虚拟骑行页改为直接展示设备连接卡片，不再通过弹层引导连接
- 清理与旧首页流程相关的状态、事件绑定和废弃样式
- 修复 `view-simulation` / `view-live` 因 `.view-section { display:flex }` 覆盖 `hidden` 而在首页一并显示的问题

### GPX 海拔与坡度修复

- 修复 GPX 缺失海拔数据时被当作 0 高程硬算坡度的问题
- 对稀疏海拔点改为先插值，再做平滑处理
- 将坡度改为按距离窗口估算，避免短距离噪声导致 20% 级别的异常坡度尖峰
- 恢复使用 GPX 分段坡度而不是整条路线平均坡度参与物理模拟
- 当 GPX 不包含海拔数据时，在路线摘要和坡度图中明确提示不可生成有效坡度

### 坡度模拟业务逻辑接入

- 新增 `domain/workout/workout-mode.js` 和 `domain/workout/grade-sim-mode.js`
- 引入训练模式状态，支持 `自由骑行` 与 `坡度模拟`
- 新增坡度模拟配置项：难度系数、前瞻距离、最大上坡、最大下坡、平滑系数
- 在实时骑行主循环中接入“当前坡度 + 前方坡度 -> 目标模拟坡度”的业务计算
- 将目标模拟坡度、前方坡度、控制状态写入 `workout.runtime`，作为后续 trainer 指令下发的标准输入
- 在虚拟骑行页面增加训练模式卡片，显示当前模式、当前坡度、前方坡度和目标模拟坡度
- 增加坡度模拟纯逻辑测试，覆盖无海拔路线、上坡和下坡约束场景

### PiP 悬浮窗布局调整

- 将 PiP 从左右分散指标改为上下结构
- 上半部分展示训练数据：模式、速度、距离、功率、心率、踏频、剩余距离
- 下半部分展示实时坡度：当前坡度、前方坡度、目标模拟坡度和坡度带状图
- 将坡度模拟控制状态也同步到 PiP，便于观察实时策略输出

### 坡度模拟界面去重

- 明确坡度模拟直接使用当前已选路线的实时梯度进行计算，不再给用户造成“第二套坡度系统”的感觉
- `live` 页面训练模式卡收敛为控制卡，只保留模式与目标模拟坡度，不再重复显示当前坡度和前方坡度
- `live` 页面只保留一处“路线坡度预览”图，避免与共享路线卡中的坡度预览重复

### live 页面业务流重排

- 将 `live` 页面顺序调整为：路线选择 -> 路线坡度预览 -> 训练模式 -> 设备连接与骑行控制 -> 导出
- 调整训练模式与设备连接文案，强调坡度模拟直接基于当前路线实时梯度，而不是额外的一套坡度系统

### 项目结构文档整理

- 新增 `project-structure.md`
- 总结当前项目的根目录结构、`src` 分层、核心模块、业务流、状态结构与后续建议

### 物理速度场景测试补充

- 在 `tests/unit/cycling-model.test.js` 新增 0% 平路、3% 上坡、-3% 下坡场景下的多功率速度测试
- 覆盖不同功率（120/180/240/300W）在同坡度下速度随功率单调上升的断言
- 覆盖同一功率下速度关系断言：`3% 上坡 < 0% 平路 < -3% 下坡`

### 模拟结果会话优先级修复

- 修复 `main-view.js` 会话选择逻辑：在 `simulation/home` 页面优先显示 `state.session`，仅在 `live` 页面优先显示 `liveRide.session`
- 避免“整段模拟后仍显示实时骑行旧会话”的速度/汇总混淆问题

### 风速物理模型修复

- 修复 `cycling-model.js` 中风速处理不一致的问题：`simulateStep` 与 `resolveSpeedTarget` 统一为空气力有方向计算
- 空气力改为 `0.5 * rho * CdA * v_air * |v_air|`，支持逆风增阻与强顺风助推
- 新增风速方向测试：平路同功率下 `顺风速度 > 无风速度 > 逆风速度`

### 物理模型文档补充

- 新增根目录 `physics.md`，整理当前速度/坡度/风速物理模型公式与参数解释
- 增加不同功率与坡度的速度对照表、220W 坡度速度图（ASCII）与风速影响表
- 增加调参建议与推荐流程，便于后续按体感和目标场景做参数校准

### Trainer Command 协议升级（预骑行锁定模式）

- 新增 `src/domain/workout/trainer-command.js`：定义统一协议字段（`protocolVersion`、`decisionPolicy`、`controlMode`、`type`、`payload`、`rideId`、`sequence`）
- 新增 `src/domain/workout/erg-mode.js`：补充 ERG 命令构建（`set-erg-power`）
- 升级 `grade-sim-mode.js`：SIM 命令改为统一协议结构（`set-sim-grade`）
- 调整 `ride-service.js`：在 `startRide` 时按训练模式锁定 `trainerControlMode`，骑行中只按锁定模式下发命令，不再中途切换
- 调整 `workout-service.js` 与初始状态：预览态支持 ERG/SIM 协议结构
- 新增/更新测试：`erg-mode.test.js`、`grade-sim-mode.test.js`、`test-runner.js`

### 三种训练模式协议落地

- 将训练模式扩展为三种：`自由骑行（固定阻力）`、`固定功率（ERG）`、`坡度模拟（SIM）`
- 新增 `src/domain/workout/resistance-mode.js`，支持固定阻力命令 `set-resistance`
- 升级 `trainer-command.js`：新增 `TRAINER_CONTROL_MODES.RESISTANCE` 与 `TRAINER_COMMAND_TYPES.SET_RESISTANCE`
- 更新 `workout-service.js` / `ride-service.js`：按三种模式在骑行开始前锁定控制模式，骑行中按锁定模式下发命令
- 更新 `index.html` 训练模式下拉与说明文案，明确“开骑后模式锁定”
- 新增测试：`tests/unit/resistance-mode.test.js`、`tests/unit/trainer-command.test.js`

### 三态训练模式 UI 同步

- 更新训练模式卡片文案与默认显示，默认展示为“自由骑行（固定阻力）”
- 训练模式摘要区改为动态目标项：按模式显示 `目标阻力 / 目标功率 / 目标模拟坡度`
- 更新 `workout-renderer.js`，根据 `trainerControlMode` 动态渲染目标标签与数值单位
- 更新 PiP 显示：目标控制卡改为动态标签与单位，支持三种模式一致展示
