# 骑行准备、设备能力与实时控制

## 单一准备状态

`src/domain/ride/ride-readiness.js` 的 `deriveRideReadiness` 是开始骑行的唯一业务判断。它同时检查已确认路线、当前模式、功率源、骑行台连接与 FTMS capability，并返回 `canStart`、结构化 `blockers`、`warnings` 和各项 requirement。UI 可以展示结果，但不能另外计算一套规则；`startRide` 必须再次调用同一函数。

debug 街景模式不是无条件旁路。选择模拟功率时可以不连接真实功率源和骑行台，但仍必须存在有效、已确认路线。debug 中选择真实设备时继续执行正式校验。

## 模式要求

| 模式 | 路线 | 功率源 | 骑行台能力 |
| --- | --- | --- | --- |
| 固定阻力 | 已确认 | 骑行台或外置功率计 | resistance |
| ERG | 已确认；可无海拔 | 骑行台或外置功率计 | target power |
| 坡度模拟 | 已确认且有海拔 | 骑行台或外置功率计 | simulation 或 inclination |

明确返回不支持时阻止启动；设备无法可靠报告 capability 时给出 warning，并在激活控制时做最佳努力验证。

## 生命周期与锁定

开始骑行后，session 保存路线、运动员参数和课表结构快照。路线和课表阶段/顺序/时长不可修改；控制模式、手动 ERG 功率、阻力和坡度模拟参数可以调整。

骑行中的控制模式切换先激活目标 FTMS 模式，成功后原子更新 `workout.mode` 与 `liveRide.session.trainerControlMode`，并清理上一模式的命令节流/去重状态。激活失败时保留原模式并记录错误。

## 设备状态

骑行台状态必须区分连接、数据流、控制激活、capability 和错误，不能只保存 `isConnected`。错误使用 `stage/message/occurredAt`，不能塞进设备名。设备连接操作位于骑行前页面；骑行 Dashboard 只展示实时状态和断线恢复入口。

## 仍需真实设备验收

- 支持/不支持 FTMS feature characteristic 的骑行台。
- SIM、ERG、固定阻力互相切换和失败回滚。
- 外置功率计优先、骑行台内置功率回退、数据超时。
- 骑行中断线、重连以及控制权重新获取。
