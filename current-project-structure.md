# 当前项目结构与第一阶段实现说明

## 当前目标

第一阶段先完成以下闭环：

- 在网页上配置路线轨迹
- 建立恒定功率下的基础物理模拟
- 生成距离-时间图像
- 保存模拟产生的速度、功率、距离、心率、坡度等数据
- 保留已有浮窗能力，用于显示模拟结果

## 当前已实现内容

### 1. 页面结构升级

入口页面已经从原来的单卡片原型，扩展为多区域布局：

- 路线轨迹设置
- 模拟参数设置
- 模拟结果面板
- 距离-时间图像
- 数据记录表格
- 悬浮窗内容配置

对应文件：

- `index.html`
- `style.css`

### 2. 路线轨迹编辑

当前阶段没有直接接入 GPX，而是先用“分段距离 + 坡度”的方式定义路线：

- 每段可以编辑名称、距离、坡度
- 支持新增路段
- 支持删除路段
- 支持恢复默认路线
- 自动计算总距离、累计爬升、累计下降

对应文件：

- `src/domain/course/route-builder.js`

### 3. 基础物理模型

当前物理模型先实现恒定功率场景下的稳态速度求解与逐秒推进：

- 输入：功率、体重、坡度、滚阻、CdA、风速
- 先根据阻力平衡估算目标速度
- 再用一阶响应方式让速度逐渐逼近目标速度
- 每秒更新距离、海拔、累计爬升
- 同时估算一个简化的心率变化

对应文件：

- `src/domain/physics/cycling-model.js`

### 4. 骑行模拟与记录

模拟器按秒生成全程记录：

- elapsedSeconds
- elapsedLabel
- power
- speedKph
- distanceKm
- heartRate
- gradePercent
- elevationMeters
- ascentMeters
- segmentName
- routeProgress

并汇总会话摘要：

- 总时长
- 总距离
- 平均速度
- 平均心率
- 累计爬升
- 当前坡度
- 路线完成度

对应文件：

- `src/domain/session/simulator.js`

### 5. 状态管理与页面渲染

当前不再把逻辑全部堆在单文件里，而是拆成：

- 应用启动与动作编排
- 状态存储
- 视图渲染

对应文件：

- `src/app/bootstrap.js`
- `src/app/store/app-store.js`
- `src/ui/renderers/main-view.js`

### 6. 浮窗复用

原来的浮窗能力已经保留，并改成可复用控制器：

- 模拟完成后可以直接展示心率、功率、时间、均功率
- 浮窗内容跟随当前页面勾选项更新

对应文件：

- `pip.js`

### 7. 本地保存与导出

当前已经支持：

- 自动保存最近一次模拟到 `localStorage`
- 页面刷新后恢复最近模拟
- 导出当前模拟为 JSON 文件
- 导出当前模拟为 FIT 文件
- FIT 活动类型标记为虚拟骑行
- FIT 导出配置支持活动标题、说明信息与仓库地址

对应文件：

- `src/adapters/export/fit-exporter.js`
- `src/adapters/storage/session-storage.js`
- `src/shared/format.js`

### 8. 蓝牙设备接入

当前已经接入两类 Web Bluetooth 设备：

- 蓝牙心率带
- 蓝牙功率计

其中功率计当前支持读取：

- 实时功率
- 踏频
- 实时均功率

并且与模拟入口并存：

- 可以单独跑模拟
- 也可以单独连接蓝牙设备
- 后续可以继续演进为“真实设备数据驱动虚拟骑行”

对应文件：

- `src/adapters/bluetooth/heart-rate-monitor.js`
- `src/adapters/bluetooth/power-meter.js`
- `src/app/bootstrap.js`
- `src/ui/renderers/main-view.js`

## 当前目录结构

```text
rider-tracker/
├── index.html
├── style.css
├── pip.js
├── app.js
├── README.md
├── auuki-architecture-physics-analysis.md
├── current-project-structure.md
└── src/
    ├── app/
    │   ├── bootstrap.js
    │   └── store/
    │       └── app-store.js
    ├── adapters/
    │   ├── bluetooth/
    │   │   ├── heart-rate-monitor.js
    │   │   └── power-meter.js
    │   ├── export/
    │   │   └── fit-exporter.js
    │   └── storage/
    │       └── session-storage.js
    ├── domain/
    │   ├── course/
    │   │   └── route-builder.js
    │   ├── physics/
    │   │   └── cycling-model.js
    │   └── session/
    │       └── simulator.js
    ├── shared/
    │   └── format.js
    └── ui/
        └── renderers/
            └── main-view.js
```

## 各层职责

### app

负责应用启动、状态初始化、事件动作编排。

### domain

负责核心业务逻辑：

- 路线构建
- 物理模型
- 模拟会话生成

### adapters

负责和外部存储或设备打交道。

当前只接了本地存储，后面可扩展：

- Web Bluetooth
- FIT 导出
- 平台上传

### ui

负责把状态渲染成页面和图表。

### shared

负责格式化、下载等公共工具。

## 当前页面可演示内容

启动本地服务后，页面可以直接演示：

1. 编辑路线分段
2. 修改恒定功率、时长、质量、CdA、Crr、风速等参数
3. 点击“运行模拟”
4. 看到：
   - 平均速度
   - 总距离
   - 平均心率
   - 累计爬升
   - 距离-时间图像
   - 秒级记录表
5. 点击“导出数据 JSON”下载当前模拟数据
6. 点击“导出 FIT”生成虚拟骑行 FIT 文件
7. 连接蓝牙心率带读取实时心率
8. 连接蓝牙功率计读取实时功率与踏频
9. 在 Chromium 浏览器中打开浮窗

当前 FIT 导出会附带：

- 虚拟骑行活动类型
- 自定义活动标题
- 设备产品名中的虚拟骑行标识
- 设备产品名中的仓库来源标识

## 当前阶段的局限

当前实现仍然是第一阶段原型，暂未包含：

- GPX 导入与地图显示
- 智能骑行台 FTMS 接入与控制
- ERG / Grade Simulation 指令下发
- 视频位置联动

## 下一步建议

建议按下面顺序继续推进：

1. 把“分段路线编辑”升级为“GPX 导入 + 分段预览”
2. 给路线加入真实经纬度与海拔点
3. 把当前模拟记录结构映射为 FIT 所需字段
4. 接入 FTMS trainer，区分“模拟输入功率”和“真实设备功率”
5. 再做 Grade Simulation 与视频联动
