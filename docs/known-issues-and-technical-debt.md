# 已知问题与技术债

本文记录已经确认、但不适合在当前迁移切片中扩大处理范围的结构问题。修复完成后应更新状态，并链接
对应 ADR 或提交；这里不替代最终架构文档。

## 活动详情 metrics 在 facts 与 artifact 中重复保存

- 状态：待处理
- 发现阶段：Python 后端收敛阶段 5C
- 当前兼容处理：已在 Node 的 canonical detail 适配层补齐热量字段，不升级既有 schema

### 现状

确定性活动指标的权威数据已经保存在 `activity_facts.metrics_json`，但生成 `activity_detail` artifact 时，
完整 `metrics` 又被复制进 `activity_artifacts.payload_json.metrics`。详情读取因此得到自包含响应，但同一份
指标存在两个持久化副本。

当前热量字段位于 `detail.metrics.scale.calories`。Rider 展示模型读取的却是
`rawSession.summary.metrics.energy.estimatedCaloriesKcal`，此前 Node 适配器没有完成这一步映射；同时，
适配器重建 `summary.metrics` 时还会覆盖虚拟骑行已经计算出的 `energy`。

### 影响

- facts 更新后，旧 detail artifact 内的 metrics 可能过期；
- 后端契约与 Rider 展示模型的 energy 字段语义不一致；
- artifact 体积增大，字段迁移需要同步维护两份持久化数据；
- FIT 原始热量和虚拟骑行功率积分热量容易在适配时丢失。

### 当前约束

阶段 5C 不修改 `activity_detail.v1`。兼容层应优先使用 FIT 的 `scale.calories` 和
`power.total_work_kj`；FIT 未提供时保留 Rider session 已计算的 energy，避免影响已有活动。

### 目标方案

1. `activity_facts.metrics_json` 保持确定性统计指标的唯一持久化来源；
2. `activity_artifacts` 只保存采样曲线、地图等重型展示数据，不再复制完整 metrics；
3. Python 在读取详情时动态组合 activity、facts、series 和 report；
4. 后续通过版本化契约把热量归入 `metrics.energy`，例如 `calories_kcal`、`mechanical_work_kj` 和来源；
5. 完成 artifact 重建/兼容策略和真实 FIT 回归后，再发布新的 activity detail schema。

## 本地路线库缺少完整的骑行生命周期

- 状态：待处理
- 发现阶段：Python 后端收敛阶段 5D 后续
- 当前兼容处理：沿用已有路线保存和未完成进度逻辑，不在本项落地前扩大路线状态语义

### 已确认的产品边界

本项第一版只覆盖用户正常点击“开始骑行”和“结束骑行”的流程，不处理浏览器崩溃、强制关闭、断电、
骑行中定时 checkpoint 或跨设备恢复。

开始骑行时仅以下三类路线应自动保存到本地路线库：

| Rider 路线来源 | 持久化来源值 | 开始时自动保存 | 结束时保存进度 |
| --- | --- | --- | --- |
| GPX 导入 | `gpx` | 是 | 是 |
| AI 路线 | `agent-planned`（存储层为 `agent`） | 是 | 是 |
| 地图选点 | `map-drawn`（存储层为 `map-draw`） | 是 | 是 |
| 地图探索 | `osm-exploration`（存储层为 `exploration`） | 否 | 否 |
| 手工路段 | `manual` | 否 | 否 |

路线来源判断应集中在一个领域函数中，避免开始骑行、路线编辑器和路线库 UI 各自维护不同的字符串判断。

### 现状

- GPX 通常在导入时保存，AI 路线在最终确认时保存；地图选点路线开始骑行前不保证已经入库；
- 只有带 `savedRouteId` 的路线才能在结束骑行时更新 `route_progress`；
- 未完成路线会保存 `resume_distance_meters`，但完成路线会删除 progress；
- 因此路线库无法区分“从未骑过”和“已经完成”；
- 地图探索路线虽然属于临时运行路线，但当前缺少统一的显式排除规则。

### 目标行为

1. 点击开始骑行时，检查当前路线来源；GPX、AI 和地图选点路线若没有 `savedRouteId`，先尝试通过现有
   fingerprint 去重逻辑保存，再将返回的 `savedRouteId` 写入本次冻结的 session 路线快照；
2. 已有 `savedRouteId` 的 GPX、AI 或地图选点路线直接使用，不重复保存；续骑产生的裁剪路线继续关联
   原始完整路线，不能把剩余几何保存成一条新路线；
3. 地图探索和手工路段直接开始骑行，不保存路线、不生成 `savedRouteId`、不写路线进度；
4. 路线库保存失败不阻止骑行，但必须明确提示“本次仍可骑行，但无法保存路线进度”；
5. 正常结束时，只处理带 `savedRouteId` 的路线。累计位置使用“续骑起点距离 + 本次骑行距离”；
6. 未到终点时保存 `status=paused` 和绝对 `resume_distance_meters`；达到终点容差时保存
   `status=completed`，不再通过删除 progress 表示完成；
7. 第一版继续使用 `route_progress` 表表示每条路线最近一次骑行状态，不新增 `route_attempts` 历史表。

### 路线库展示语义

- 无 progress：尚未骑行；
- `paused`：未完成，显示已骑距离并启用“继续骑行”；
- `completed`：已完成，禁用“继续骑行”，仍允许“从起点使用”；
- 完成判断暂时沿用距离终点不足 10 米的容差。

### 预计修改范围

- `src/app/services/ride-service.js`：开始前确保允许持久化的路线已保存，结束时提交路线状态；
- `src/app/services/route-editor-service.js`：提炼统一的路线保存和来源判断，计算绝对累计进度；
- `src/ui/renderers/route-library-renderer.js`：展示尚未骑行、未完成和已完成状态；
- `services/training-agent/storage/repositories/saved_route.py`：让 progress 明确支持 `paused/completed`；
- `services/training-agent/app/api.py` 及 Node BFF：扩展进度协议并保持结构化错误；
- 对应的 Python 仓储/API、JavaScript 服务/UI 和正常双进程回归测试。
