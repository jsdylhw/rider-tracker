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
