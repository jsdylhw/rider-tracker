# Rider Tracker 文档

文档分为三部分：**项目结构、代码处理规划、项目改动日志**。先看结构了解现状，需要安排工作时再看规划；历史日志不作为当前实现的依据。

用户安装和启动见 [项目 README](../README.md)。当前默认入口是 `npm start` → Python Web；旧 Node 入口通过 `npm run start:legacy` 回退。

## 1. 项目结构 · architecture

说明模块职责、运行方式、业务契约和长期使用的操作方法。功能变化时更新原文，不在末尾追加每轮排查过程。

| 主题 | 文档 |
| --- | --- |
| 开发入口、代码位置、验证命令 | [开发与排障指南](architecture/development-guide.md) |
| 冻结的架构决策与迁移阶段 | [最终架构](architecture/rider-final-architecture-and-python-migration.md) |
| JavaScript 分层 / UI 边界 | [代码分层](architecture/source-architecture.md) · [前端结构](architecture/frontend-architecture.md) |
| Rider 与 Python、Agent 的集成 | [集成说明](architecture/training-agent-integration.md) |
| 配置与能力 | [功能矩阵](architecture/feature-capability-matrix.md) |
| 骑行准备、设备与控制模式 | [骑行控制](architecture/ride-readiness-and-control.md) |
| Agent 会话 / 失败结果契约 | [会话管理](architecture/agent-sessions.md) · [失败出口](architecture/agent-failure-outcomes.md) |
| 路线规则 / 测试职责 | [国内约束与偏好](architecture/domestic-route-preferences.md) · [路线测试基准](architecture/route-testing-baseline.md) |
| 讲解 / 路线导入 | [路线讲解](architecture/route-narration.md) · [Strava 导入](architecture/strava-route-import.md) |
| 发布、安装与回退 | [发布操作指南](architecture/python-release-runbook.md) |

Python 内部边界见 [后端开发说明](../services/training-agent/CLAUDE.md)，工具命令见 [后端 README](../services/training-agent/README.md)。

## 2. 代码处理规划 · plans

说明要解决的问题、修改范围、当前状态和完成条件。已完成的实施过程放入改动日志，不把历史计划当成待办。

| 主题 | 文档 |
| --- | --- |
| 后端融合的目标与剩余门槛 | [后端融合规划](plans/backend-unification-goal.md) |
| Browser API 迁移清单 | [浏览器入口清单](plans/python-browser-entry-checklist.md) |
| 明确延期的问题 | [已知问题与技术债](plans/known-issues-and-technical-debt.md) |
| 路线恢复的已有边界与后续切片 | [路线恢复规划](plans/route-planning-recovery.md) |

规划只记录确定要跟踪的工作，不自动把每轮评测发现扩展成新重构任务。冻结架构的阶段定义保留在结构区，实际完成状态以改动日志和代码为准。

## 3. 项目改动日志 · changelog

记录实际改了什么、为什么改、兼容影响及关联提交；按模块或日期归并，避免为每次对话新建报告。

| 主题 | 文档 |
| --- | --- |
| Python 后端融合决策与实施历史 | [ADR 0001](changelog/adr/0001-python-backend-consolidation.md) |
| 路线模块历次改动 | [路线实施记录](changelog/route-agent-implementation.md) |
| 会话与讲解的历史改动 | [功能改动记录](changelog/feature-changes.md) |

原有审计、实验与已实施方案保留在 [历史归档](changelog/archive/README.md)，仅供追溯，不继续追加日常测试流水。

**评测结果直接在对话里汇报**，包括通过项、失败原因、证据边界和需要用户决定的事项，不另写评测报告，也不复制进改动日志。可复用的数据集、预期行为和运行方式与代码一起维护：见 [Agent 评测入口](../services/training-agent/evaluation/README.md) 和 [对话场景](../services/training-agent/evaluation/dialogue-scenarios.md)。机器结果文件作为本地运行产物保留。

更新文档时遵循：

- 当前行为或契约变化 → 修改结构说明。
- 待办范围或状态变化 → 修改规划。
- 已落地的行为或架构决策 → 简要记录改动日志；测试细节在对话或提交的 `Validation` 中说明。
- 移动文档 → 同步修正根 README、AGENTS、相互链接及引用文档的发布脚本。
