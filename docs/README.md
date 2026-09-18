# Rider Tracker 文档导航

本文档帮助开发者和编码 Agent 快速判断“先读什么”和“哪份文档具有决定权”。如果文档与当前代码不一致，
先通过测试和调用链确认事实，再更新相应的动态文档；不要静默修改冻结的架构决策。

## 首次进入项目

推荐阅读顺序：

1. [`../README.md`](../README.md)：产品能力、启动方式和用户配置。
2. [`development-guide.md`](development-guide.md)：代码入口、主要时序、排障方法和验证命令。
3. [`source-architecture.md`](source-architecture.md)：JavaScript 分层及新代码归属。
4. [`adr/0001-python-backend-consolidation.md`](adr/0001-python-backend-consolidation.md)：迁移实际进展和已经落地的决策。
5. [`known-issues-and-technical-debt.md`](known-issues-and-technical-debt.md)：明确推迟的问题，避免重复发现或越界修复。

Python Training Backend 内部开发还应阅读：

- [`../services/training-agent/CLAUDE.md`](../services/training-agent/CLAUDE.md)：Agent、Skill、Tool、Service、Repository 边界。
- [`../services/training-agent/README.md`](../services/training-agent/README.md)：Python 服务命令、数据和功能说明。

## 文档权威层级

| 类别 | 文档 | 用途 |
| --- | --- | --- |
| 最终架构 | [`rider-final-architecture-and-python-migration.md`](rider-final-architecture-and-python-migration.md) | 冻结的目标、阶段顺序和完成门槛；实现收尾时不直接改写 |
| 实施记录 | [`adr/0001-python-backend-consolidation.md`](adr/0001-python-backend-consolidation.md) | 已完成切片、边界、验证结果和迁移决定 |
| 开发入口 | [`development-guide.md`](development-guide.md) | 当前代码导航、排障与验证 |
| 代码归属 | [`source-architecture.md`](source-architecture.md)、[`frontend-architecture.md`](frontend-architecture.md) | JS 分层、UI 与 renderer 边界 |
| 产品规则 | 专题文档 | readiness、路线、讲解、Strava 和 capability 的业务约束 |
| 待办债务 | [`known-issues-and-technical-debt.md`](known-issues-and-technical-debt.md) | 已确认但延期处理的问题 |
| 历史方案 | [`remove-training-agent-legacy-web-ui-plan.md`](remove-training-agent-legacy-web-ui-plan.md) | 已实施方案的历史依据，不作为当前运行结构入口 |

## 按问题查文档

| 任务 | 先读文档 |
| --- | --- |
| 骑行能否开始、设备/控制模式 | [`ride-readiness-and-control.md`](ride-readiness-and-control.md) |
| 配置缺失时哪些功能可用 | [`feature-capability-matrix.md`](feature-capability-matrix.md) |
| 目标距离验收与真实 Agent 对话 | [`route-distance-dialogue-validation.md`](route-distance-dialogue-validation.md) |
| 国内路线自然语言约束和排序 | [`domestic-route-preferences.md`](domestic-route-preferences.md) |
| Agent 失败出口、公开诊断 | [`agent-failure-outcomes.md`](agent-failure-outcomes.md) |
| 路线错误恢复、成功地点复用 | [`route-planning-recovery.md`](route-planning-recovery.md) |
| 独立 Route Agent、任务契约与页面接入 | [`route-agent-implementation.md`](route-agent-implementation.md) |
| AI 路线、Node/Python 接入 | [`training-agent-integration.md`](training-agent-integration.md) |
| 街景讲解、卡片和异步任务 | [`route-narration.md`](route-narration.md) |
| Strava 路线缓存和导入 | [`strava-route-import.md`](strava-route-import.md) |
| UI、View、renderer 和 CSS | [`frontend-architecture.md`](frontend-architecture.md) |
| 迁移阶段和 Node 删除条件 | [`rider-final-architecture-and-python-migration.md`](rider-final-architecture-and-python-migration.md) |

## 更新规则

- 用户功能或配置关系变化：更新对应专题文档和必要的 README。
- 架构切片完成：在 ADR 追加实施结果、边界和验证，不重写最终架构文档的阶段定义。
- 新增或关闭技术债：更新 `known-issues-and-technical-debt.md` 的状态，并链接提交或 ADR。
- 路径、命令或模块 owner 变化：同步更新 `development-guide.md` 和本索引。
- 文档中的测试数字是历史验收记录，不代表当前工作区；当前结果必须重新运行并单独报告。
