# Auuki 中 ERG、坡度模拟、功率计分发与速度计算分析

## 文档目标

本文档专门回答下面几个问题，并且尽量写到可以直接指导你实现自己项目的程度：

1. Auuki 是怎么做 **ERG** 的
2. Auuki 是怎么做 **坡度模拟** 的
3. 连接外部 **功率计** 之后，ERG / 坡度模拟 / 固定阻力这三类控制是怎么分发的
4. 蓝牙控制链路与数据回传链路是怎么组织的
5. 在实际骑行中，如果模拟一个很陡的坡，例如你说的“15度坡”或“15% 坡”，当功率只有 `150W` 左右时，为什么仍然会有一个很低但非零的速度，Auuki 里这个速度是怎么算出来的
6. 如果你想自己做一个骑行台坡度模拟系统，应该如何模仿 Auuki 的实现

---

## 一、先说最重要的结论

### 1. Auuki 的 ERG 不是浏览器自己闭环控阻

Auuki 在 ERG 模式下做的是：

- 保存当前 `powerTarget`
- 在 trainer 连接成功后，把目标功率发给 trainer
- trainer 自己在固件内部做闭环阻力控制
- trainer 再把当前功率/速度/踏频回传给 Auuki

也就是说：

- **Auuki 负责“发目标”**
- **trainer 负责“调阻力”**

### 2. Auuki 的坡度模拟做了两件事

同一个坡度状态 `slopeTarget` 会同时用于：

- 给 trainer 发 simulation / grade 命令
- 给本地物理模型计算速度、距离、海拔、爬升

所以 Auuki 的坡度模拟不是单一动作，而是“真实 trainer 控制 + 本地虚拟物理”的双通路。

### 3. 连接外部功率计以后，控制权并不会跟着切走

如果你把 `power` 数据源切到外部功率计：

- 显示出来的功率可以来自功率计
- 记录下来的功率也可以来自功率计
- 但是 **ERG / 坡度模拟 / 固定阻力** 的控制命令仍然由 `controllable trainer` 负责执行

也就是说：

- **功率源** 可以切到外部功率计
- **控制源** 仍然还是 trainer

Auuki 里没有看到“把外部功率计读数实时回灌给 trainer 做 power match”的闭环。

### 4. 你看到的 “1-2 速度” 很可能是 `m/s`

Auuki 内部的 `speed` 和 `speedVirtual` 都是按 **m/s** 存的，不是 km/h。

所以如果你看到：

- `1.0 ~ 2.0`

那它实际上对应：

- `3.6 ~ 7.2 km/h`

而这在陡坡、低功率状态下是完全合理的。

---

## 二、Auuki 的核心状态与控制对象

要理解整个系统，先抓住这几个核心状态。

### 1. 模式状态

Auuki 定义的主要模式在 `src/ble/enums.js`：

- `erg`
- `sim`
- `resistance`

其中：

- `erg` 表示目标功率控制
- `sim` 表示坡度模拟
- `resistance` 表示固定阻力

### 2. 目标状态

在 `src/db.js` 中，trainer 控制相关的核心目标值是：

- `db.powerTarget`
- `db.resistanceTarget`
- `db.slopeTarget`

### 3. 实时数据状态

实时测量值主要有：

- `db.power`
- `db.speed`
- `db.cadence`
- `db.heartRate`

以及本地物理模型计算出的：

- `db.speedVirtual`
- `db.distance`
- `db.altitude`
- `db.ascent`

### 4. 数据源选择状态

Auuki 还有一个很关键的状态对象：

- `db.sources`

默认值在 `src/models/models.js` 中大致是：

```text
power:   ble:controllable
cadence: ble:controllable
speed:   ble:controllable
control: ble:controllable
virtualState: power
```

这说明默认情况下：

- 功率来自 trainer
- 踏频来自 trainer
- 速度来自 trainer
- 控制也来自 trainer
- 虚拟状态计算默认按功率驱动

---

## 三、蓝牙是怎么分发的

这一节讲清楚 Auuki 的 BLE 结构。

### 1. 最底层：Web Bluetooth UUID 与过滤器

文件：

- `src/ble/web-ble.js`

这里定义了：

- FTMS service UUID
- cycling power service UUID
- FEC UUID
- Wahoo 相关 UUID
- 所有 characteristic UUID

同时定义了几类设备过滤器：

- controllable
- powerMeter
- speedCadenceSensor
- heartRateMonitor

其中 `controllable()` 这个过滤器会接受：

- FTMS trainer
- FEC over BLE trainer
- Wahoo trainer
- 某些带 cycling power 的可控设备

### 2. 设备实例层：每类设备一个 ReactiveConnectable

文件：

- `src/ble/devices.js`

Auuki 创建了多个连接器对象，例如：

- `controllable`
- `powerMeter`
- `heartRateMonitor`
- `speedCadenceSensor`

你可以把它理解成：

- trainer 一个连接器
- 功率计一个连接器
- 心率带一个连接器
- 速度踏频器一个连接器

每个连接器都独立接收各自设备的数据，但最终会统一汇入 `db`。

### 3. 连接层：Connectable

文件：

- `src/ble/connectable.js`

它负责：

- `navigator.bluetooth.requestDevice(...)`
- `device.gatt.connect()`
- `getPrimaryServices()`
- 根据服务能力决定该设备怎么初始化

对 trainer 来说，`defaultSetup()` 会按顺序选择协议服务：

1. FTMS
2. FEC
3. WCPS

并且只保留一个：

- `services.trainer`

这点很关键，因为它避免了：

- 同一个 trainer 同时被多个控制协议写入
- 阻力跳动和控制冲突

### 4. 协议服务层：FTMS / FEC / WCPS

每种协议都有一个 service 封装：

- `src/ble/ftms/ftms.js`
- `src/ble/fec/fec.js`
- `src/ble/wcps/wcps.js`

它们对上层暴露统一接口：

- `setPowerTarget(...)`
- `setResistanceTarget(...)`
- `setSimulation(...)`

但在内部会编码成不同协议的数据包。

### 5. 通知与写入层：Service + Characteristic

文件：

- `src/ble/service.js`
- `src/ble/characteristic.js`

这里统一处理：

- characteristic 获取
- notifications 启动
- write / writeWithRetry
- control point 的 `block()` / `release()`

这套设计使 trainer 控制能稳定工作。

### 6. 上行数据分发：设备 -> db

文件：

- `src/ble/reactive-connectable.js`

这是最关键的分发桥。

trainer 或功率计等设备回传的数据会先进入：

- `onData(data)`

然后 Auuki 会检查当前数据源选择是否匹配。

例如：

- 如果数据里有 `power`
- 并且当前 `models.sources.isSource('power', identifier)` 为真
- 才会真正派发 `xf.dispatch('power', data.power)`

也就是说：

- 一个设备发来的数据，不一定全部被系统采用
- 是否采用，由 `db.sources` 决定

这就是 Auuki 的“蓝牙分发开关”。

### 7. 下行控制分发：db -> trainer

同一个 `ReactiveConnectable` 还负责订阅：

- `db:mode`
- `db:powerTarget`
- `db:resistanceTarget`
- `db:slopeTarget`

然后根据当前 mode 决定下发哪个命令：

- `erg` 时下发 `setPowerTarget`
- `resistance` 时下发 `setResistanceTarget`
- `sim` 时下发 `setSimulation`

所以，Auuki 的蓝牙控制分发，不是按钮直接写 BLE，而是：

```text
UI -> db -> ReactiveConnectable -> trainer service -> BLE characteristic
```

这是非常适合模仿的设计。

---

## 四、连接功率计以后，ERG / 坡度模拟 / 固定阻力是怎么分发的

这是你问题里非常关键的一部分。

### 1. 功率计连接后，并不会替代 trainer 控制器

Auuki 中 trainer 的控制命令只由：

- `ble:controllable`

对应的连接器去执行。

控制分发逻辑订阅的是：

- `db:mode`
- `db:powerTarget`
- `db:resistanceTarget`
- `db:slopeTarget`

而不是：

- `db.power`
- `db.speed`
- `db.cadence`

所以控制命令不依赖实时功率源来自哪台设备。

### 2. `power` 可以切给功率计，但 `control` 仍然保留给 trainer

在 `src/models/models.js` 中默认 sources 是：

```text
power:   ble:controllable
control: ble:controllable
```

在 `src/index.html` 和 `src/views/connection-switch.js` 中，用户可以把某个指标的 source 切走，例如：

- `power -> ble:powerMeter`
- `cadence -> ble:powerMeter`
- `speed -> ble:speedCadenceSensor`

但是 `control` 这一路并没有对应“切到 powerMeter”的逻辑。

这意味着：

- 功率读数可以来自功率计
- trainer 控制仍然是 trainer 自己

### 3. 因此实际分发结果如下

#### 情况 A：只连 trainer

- 功率来自 trainer
- 速度来自 trainer
- ERG 命令也发给 trainer
- Sim 命令也发给 trainer

#### 情况 B：trainer + 外部功率计

- 功率可以来自功率计
- trainer 仍然接收 ERG / Sim / Resistance 控制命令
- trainer 自己内部仍按自己的功率模型做 ERG 闭环
- Auuki 没有把功率计读数回写给 trainer 做 power match

#### 情况 C：trainer + 外部速度踏频器

- 显示速度/踏频可以来自外部设备
- trainer 控制仍由 trainer 自己执行

### 4. 这意味着什么

如果你在自己的项目里也这么设计，那么会得到和 Auuki 一样的行为：

- **控制权与数据源是分开的**

好处：

- 灵活
- 可用外部功率计做显示/记录
- trainer 控制链路简单稳定

代价：

- 如果你希望做“外部功率计 power match”
- 这套结构还不够，需要额外加一个控制闭环

### 5. 什么叫 power match，这里为什么要提

因为很多人一看到：

- 连接功率计
- 再开 ERG

会以为 trainer 会按外部功率计来控阻。

但 Auuki 现有结构不是这样。

Auuki 现在更接近：

- **数据选择**
- 而不是 **控制闭环重定向**

所以如果你在自己的项目里需要“功率计 power match”，你要新增一层：

```text
targetPower - externalPowerMeterMeasuredPower = error
error -> 调整 trainer targetPower 或 resistance
```

这层 Auuki 目前没有看到。

---

## 五、Auuki 是怎么做 ERG 的

### 1. 模式切换

用户点击 ERG 或按键 `E` 后，最终会发送：

- `ui:mode-set('erg')`

`db.js` 收到后会：

- 设置 `db.mode = 'erg'`
- 再派发一次当前 `powerTarget`

这样 trainer 会立即同步目标功率。

### 2. 目标功率更新

目标功率变化来源可以是：

- 按钮加减
- 输入框输入
- 键盘上下键
- workout 自动更新

最终都会变成：

- `db.powerTarget`

### 3. 控制分发

`ReactiveConnectable` 监听到 `db:powerTarget` 后，会检查：

- 是否已连接
- 当前模式是否为 `erg`

如果满足条件，就调用：

- `trainer.setPowerTarget({ power })`

### 4. 协议编码

如果当前 trainer 走的是 FTMS：

- 会写入 `Fitness Machine Control Point`
- opcode 是 `0x05`

即：

```text
Set Target Power
```

如果是 FEC 或 WCPS：

- 则分别走自己的协议编码器

### 5. trainer 内部闭环

trainer 收到目标功率后：

- 按自己的固件逻辑调电磁阻力
- 让实时功率尽量接近目标功率

Auuki 本身不在前端实现这个闭环。

---

## 六、Auuki 是怎么做坡度模拟的

### 1. 坡度目标状态

坡度模拟核心状态是：

- `db.slopeTarget`

其范围由 `models.slopeTarget` 限定，默认是：

- `-40 ~ 40`

注意这个值在 Auuki 的语义是：

- **坡度百分比**

不是角度。

也就是说：

- `15` 表示 `15%`
- 不是 `15°`

### 2. 下发给 trainer

当模式是 `sim` 时，`ReactiveConnectable` 收到 `db:slopeTarget` 后会调用：

- `trainer.setSimulation({ grade: slopeTarget })`

在 FTMS 下会编码为：

- `Indoor Bike Simulation Parameters`

其中包括：

- `grade`
- `windSpeed`
- `crr`
- `windResistance`

### 3. 同时进入本地物理模型

同一个 `db.slopeTarget` 会在物理模型入口被除以 100：

```text
slope = db.slopeTarget / 100
```

然后参与：

- 重力阻力
- 滚阻
- 距离/海拔/爬升积分
- 虚拟速度求解

### 4. Course 模式下坡度怎么变

如果加载了 course：

- `src/course.js` 会根据当前 `distance`
- 找到当前 segment
- 取出该 segment 的 `slope`
- 更新 `ui:slope-target-set`
- 并切到 `sim`

这意味着：

- Course 只是上层坡度发生器
- 真正的控制与速度计算仍复用同一套 `slopeTarget` 机制

---

## 七、速度单位到底是什么

这一点必须先说清楚，因为很多“为什么只有 1-2 速度”的疑惑，本质上是单位没对齐。

### 1. Auuki 内部存的是 m/s

在 `src/models/models.js` 的 `Speed` 模型里有：

```text
kmhToMps(kmh) = kmh / 3.6
mpsToKmh(mps) = mps * 3.6
```

而 `ReactiveConnectable.onData()` 收到 trainer 的速度后，也会做：

```text
xf.dispatch('speed', models.speed.kmhToMps(data.speed))
```

也就是说：

- trainer 回来的速度如果是 km/h
- 存进 `db.speed` 之前会先转成 m/s

### 2. UI 显示时再转回 km/h

在 `src/views/data-views.js` 中，`SpeedValue` 显示时会把内部 m/s 转回：

- km/h

所以：

- 内部状态：`m/s`
- 屏幕展示：通常是 `km/h`

### 3. 这会导致一个常见误解

如果你是：

- 看调试日志
- 看内部状态
- 看某个 data binding

那么你可能看到：

- `1.1`
- `1.5`
- `2.0`

这些值其实不是 `km/h`，而是：

- `1.1 m/s = 4.0 km/h`
- `1.5 m/s = 5.4 km/h`
- `2.0 m/s = 7.2 km/h`

所以你说的“只有 1-2 的速度”，如果是内部值，那其实完全合理。

---

## 八、15% 或 15度 坡、150W 时，为什么仍然会有低速前进

这一节重点把这个问题讲清楚。

### 1. 先区分两个概念

这是最重要的一步。

#### 情况 A：你说的是 15%

在 Auuki 中，如果你设置：

- `slopeTarget = 15`

它表示的是：

- `15% 坡`

不是：

- `15°`

#### 情况 B：你说的真的是 15度

如果是真实几何角度 `15°`，那它对应的坡度百分比大约是：

```text
tan(15°) ≈ 0.2679 ≈ 26.8%
```

也就是说：

- `15°` 是一个非常非常陡的坡
- 它远远陡于 `15%`

所以必须先把这两个概念分开，否则速度判断会差很多。

### 2. Auuki 的速度模型本质

Auuki 的功率驱动速度主模型是：

- `virtualSpeedCF()`

这个模型本质上在每个时间步解一个三次方程：

```text
c3 * v^3 + c2 * v^2 + c1 * v + c0 = 0
```

里面包含：

- 重力阻力
- 滚阻
- 风阻
- 动能变化
- 传动损失

### 3. 为什么低功率时仍然不是零速

因为只要你的输入功率还足够克服：

- 重力分量
- 滚阻
- 低速下的少量风阻

那么方程就会有一个正实根，也就是：

- 一个很低但非零的正速度

只有当输入功率低到连这些阻力都克服不了时：

- 求出来的速度才会非常接近 0
- 或被模型归零

### 4. 用 Auuki 默认参数做近似估算

用 Auuki 默认参数：

- `mass = 85kg`
- `crr = 0.004`
- `CdA = 0.4`
- `rho = 1.275`
- `drivetrainLoss = 0.02`

近似估算 `150W` 时的结果如下。

#### 情况 A：15% 坡

把 `slope = 0.15` 代入，使用 Auuki 同类物理参数近似求解，可得：

- 速度约 `1.15 m/s`
- 即约 `4.16 km/h`

这个结果非常关键，因为它说明：

- 如果你在内部状态里看到 `1.1` 左右
- 那其实正好就是 15% 坡、150W 的合理结果

#### 情况 B：15°

如果坡度是真正的 `15°`，也就是大约 `26.8%`：

- 速度约 `0.67 m/s`
- 即约 `2.42 km/h`

所以如果你看到的是：

- `1 ~ 2 km/h`

那更接近的是：

- 非常陡的角度坡
- 或者 trainer 自己的速度模型
- 或者极低踏频下 trainer 回传速度

### 5. 为什么 150W 还推得动

因为低速时风阻很小，主要要克服的是：

- 重力阻力
- 滚阻

以 15% 坡为例，近似力平衡大致是：

```text
P = F_total * v
```

如果：

- 有效输入功率约 `150 * (1 - 0.02) = 147W`
- 总阻力约 `127N`

那么：

```text
v ≈ 147 / 127 ≈ 1.16 m/s
```

也就是：

- 约 `4.2 km/h`

这正和 Auuki 模型的近似结果一致。

### 6. 为什么你实际看到的速度可能更低

因为 Auuki 不一定始终使用本地 `virtualSpeedCF()` 结果显示速度，还取决于：

- `virtualState` 是 `power` 还是 `speed`
- 当前速度显示源是 trainer 还是虚拟速度

如果当前系统用的是 trainer 的真实速度：

- trainer 自己可能用另一套轮速/飞轮/阻力映射
- 低踏频下速度可能比 Auuki 本地虚拟速度更低
- 某些 trainer 的速度在高阻力、低转速下会掉得更快

---

## 九、Auuki 在 ERG 和坡度模拟下到底怎么算速度

这一节必须分两个维度说：

1. 当前 mode 是什么
2. 当前 `virtualState` 是什么

### 1. mode 决定控制命令

Auuki 的 mode 决定的是 trainer 如何被控制：

- `erg` -> 发目标功率
- `sim` -> 发坡度模拟
- `resistance` -> 发固定阻力

### 2. virtualState 决定速度计算方式

Auuki 里真正决定“速度怎么算”的，不是 mode，而是：

- `db.sources.virtualState`

它有两个值：

- `power`
- `speed`

### 3. 当 `virtualState = power`

这时使用：

- `virtualSpeedCF()`

输入：

- 当前功率 `db.power`
- 当前坡度 `db.slopeTarget / 100`
- 质量
- 风阻参数
- `dt`
- 上一时刻速度

输出：

- `speedVirtual`
- `distance`
- `altitude`
- `ascent`

也就是说：

#### ERG 下

- trainer 把功率拉向目标值
- Auuki 读取实时功率
- 再用这个功率和坡度去算虚拟速度

链路是：

```text
powerTarget
-> trainer ERG control
-> measured power
-> db.power
-> virtualSpeedCF()
-> speedVirtual
```

#### Sim 下

- trainer 按坡度改变真实阻力
- 骑手实际输出功率变化
- Auuki 读取这个实时功率
- 同时用更高的坡度参与速度求解

链路是：

```text
slopeTarget
-> trainer simulation resistance
-> rider output power changes
-> db.power
-> virtualSpeedCF(slope, power)
-> speedVirtual
```

### 4. 当 `virtualState = speed`

这时使用：

- `trainerSpeed()`

输入：

- `db.speed`
- `db.slopeTarget / 100`
- `distance`
- `altitude`
- `ascent`
- `dt`

输出：

- `distance`
- `altitude`
- `ascent`

注意它不会自己求速度，它只做积分。

也就是说：

#### ERG 下

- 速度直接取 trainer 回传速度
- Auuki 不再用功率反算速度

#### Sim 下

- 速度仍直接取 trainer 回传速度
- 坡度只用于积分海拔、爬升、路线推进

### 5. 这就是为什么同样 150W，看到的速度可能不同

因为你可能处于两种不同配置之一：

#### 配置 A：功率驱动虚拟速度

- 速度是 Auuki 物理模型算出来的

#### 配置 B：trainer 真实速度驱动

- 速度是 trainer 自己算出来回传的

同样是：

- 15% 坡
- 150W

两边算出的速度不一定完全一样。

---

## 十、Auuki 的 FTMS 流程怎么跑通

这里以 FTMS 为例，把整条 BLE 控制链写清楚。

### 1. 连接阶段

1. `navigator.bluetooth.requestDevice(...)`
2. GATT connect
3. 获取 primary services
4. 检测到 `fitnessMachine` service
5. 初始化 FTMS service
6. 绑定：
   - `Indoor Bike Data`
   - `Fitness Machine Control Point`
7. 调用 `requestControl`

### 2. ERG 阶段

1. `db.mode = erg`
2. `db.powerTarget` 更新
3. `ReactiveConnectable.onPowerTarget()`
4. `trainer.setPowerTarget({ power })`
5. FTMS 编码为 `opcode 0x05`
6. 写入 control point
7. trainer 内部调阻
8. trainer 回传 measurement

### 3. Sim 阶段

1. `db.mode = sim`
2. `db.slopeTarget` 更新
3. `ReactiveConnectable.onSlopeTarget()`
4. `trainer.setSimulation({ grade })`
5. FTMS 编码为 `opcode 0x11`
6. 写入 control point
7. trainer 模拟坡度阻力
8. trainer 回传 measurement

### 4. Resistance 阶段

1. `db.mode = resistance`
2. `db.resistanceTarget` 更新
3. `ReactiveConnectable.onResistanceTarget()`
4. `trainer.setResistanceTarget({ resistance })`
5. FTMS 编码为 `opcode 0x04`
6. 写入 control point

---

## 十一、如果你要模仿 Auuki，实现自己的坡度模拟系统

这里给你一个最实用的落地建议，不绕弯。

### 第一阶段：做最小系统

你先只做下面 6 件事。

#### 1. 只支持 FTMS

先不要同时做：

- FTMS
- FE-C
- 厂商私有协议

因为 FTMS 足够把系统跑通。

#### 2. 建最小状态仓库

至少保存：

```text
mode
powerTarget
resistanceTarget
slopeTarget
power
speed
cadence
distance
altitude
ascent
virtualState
```

#### 3. 建统一 trainer 接口

```ts
requestControl()
setPowerTarget({ power })
setResistanceTarget({ resistance })
setSimulation({ grade, windSpeed, crr, windResistance })
reset()
```

#### 4. 建控制分发器

```ts
if (mode === 'erg') setPowerTarget(powerTarget)
if (mode === 'sim') setSimulation({ grade: slopeTarget })
if (mode === 'resistance') setResistanceTarget(resistanceTarget)
```

#### 5. 建测量分发器

统一把 BLE 回传数据映射为：

```ts
power
speed
cadence
heartRate
```

#### 6. 建本地物理层

先实现两个函数就够了：

- `virtualSpeedCF(...)`
- `trainerSpeed(...)`

### 第二阶段：做你真正想要的坡度模拟

如果你想得到和 Auuki 类似的效果，必须把“trainer 坡度控制”和“本地路线/速度模型”同时做好。

推荐结构：

```text
Course / Route
-> slopeTarget

slopeTarget
-> trainer.setSimulation({ grade })
-> physics.virtualSpeedCF(...) or trainerSpeed(...)

power / speed measurement
-> db
-> display + record + physics
```

### 第三阶段：如果你还想支持外部功率计

建议你先做两种模式：

#### 模式 A：数据替换模式

和 Auuki 一样：

- 只切换显示和记录的数据源
- 控制仍由 trainer 自己完成

优点：

- 简单
- 稳定

#### 模式 B：真正 power match 模式

额外增加一个闭环：

```text
error = targetPower - externalPowerMeterPower
adjust trainer targetPower/resistance based on error
```

这一步 Auuki 目前没有完整实现，所以如果你要做，会比 Auuki 更进一步。

---

## 十二、一个你可以直接照着抄的架构蓝图

### 模块 1：BLE Device Manager

负责：

- request device
- connect GATT
- discover services

### 模块 2：Trainer Adapter

负责：

- FTMS 编码解码
- `requestControl`
- `setPowerTarget`
- `setSimulation`
- `setResistanceTarget`

### 模块 3：Measurement Router

负责：

- 接收 trainer / power meter / cadence sensor 的数据
- 根据 `sources` 选择写入哪个状态字段

### 模块 4：Control Router

负责监听：

- `mode`
- `powerTarget`
- `slopeTarget`
- `resistanceTarget`

并路由到 trainer adapter。

### 模块 5：Physics Engine

负责：

- `virtualSpeedCF`
- `trainerSpeed`
- `distance/altitude/ascent`

### 模块 6：Course Engine

负责：

- 根据距离找到当前 segment
- 输出坡度到 `slopeTarget`

### 模块 7：UI

只做：

- 改状态
- 展示状态

绝不要让 UI 直接写蓝牙 characteristic。

---

## 十三、最后的实践建议

如果你的目标是尽快做出一个能用的坡度模拟系统，我建议你按下面顺序：

1. 先接通 FTMS trainer
2. 实现 `requestControl`
3. 实现 ERG
4. 实现坡度模拟
5. 收到 power/speed/cadence 并显示
6. 本地加 `trainerSpeed()`，先把海拔/距离/爬升做出来
7. 再加 `virtualSpeedCF()`，实现功率驱动虚拟速度
8. 最后再加外部功率计源选择
9. 如果需要，再做 power match

---

## 十四、结论

把整件事总结成一句话：

- **Auuki 的 ERG 是“目标功率下发 + trainer 固件闭环”**
- **Auuki 的坡度模拟是“trainer grade 控制 + 本地物理模型共享同一坡度状态”**
- **Auuki 的蓝牙分发是“设备数据先按 source 选择进入 db，控制命令再由 mode 从 db 路由回 trainer”**
- **外部功率计只替换测量数据，不接管 trainer 控制**
- **15% 坡下 150W 对应约 `1.15 m/s`，也就是约 `4.16 km/h`，因此你看到的 `1-2` 很可能是内部 `m/s` 值而不是 km/h**

如果你要做自己的系统，最值得模仿的不是某个具体函数，而是这 4 个设计原则：

1. 控制与数据显示分离
2. 数据源与控制源分离
3. 协议层与业务层分离
4. 坡度状态同时驱动 trainer 与本地物理模型
