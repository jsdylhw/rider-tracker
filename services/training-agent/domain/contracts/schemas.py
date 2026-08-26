"""Rider / Training Agent 稳定数据契约注册表。

为什么需要这个文件
------------------
过去不少 Python 函数只要返回 ``dict``，就顺手添加一个独立的
``schema_version``。这会把普通函数返回值误认为长期协议，使调用方开始依赖
``activity_operation_*``、``activity_selection.*`` 等内部实现细节。最终结果是：

* 修改一个内部函数也像在修改公开 API；
* Presentation 投影需要理解大量相互重叠的 schema；
* 开发者无法分辨哪些格式必须兼容旧数据；
* 测试大量断言 schema 名称，却没有真正验证业务边界。

本注册表只记录确实需要兼容性保证的契约。满足以下至少一项才允许加入：

1. 通过 Python -> Node -> Browser 或其他进程边界传输；
2. 写入 SQLite、JSON 工作流或其他持久化介质，重启后仍要读取；
3. 被缓存、恢复或重放，生产者和消费者可能运行不同版本代码。

同一 Python 进程内的函数返回值不属于稳定 schema。它们应使用 ``kind``、
``operation`` 和 ``status`` 表达用途，例如 ``kind=activity_selection``；这些字段
只是内部分发标签，不承诺跨版本兼容。

版本规则
--------
* 兼容地增加可选字段：保持当前版本；
* 删除字段、改变含义或改变单位：升级主版本；
* 新版本上线前必须同时考虑旧数据库、旧缓存和旧浏览器消费者；
* 不允许仅为了“看起来结构化”就在这里增加 schema。

当前部分名称（如 ``llm_fit_file_analysis.v2`` 和
``analysis_navigation.v1``）沿用历史格式，是为了避免本轮同时引入数据库迁移。
它们的常量名表达新的业务角色；未来若改名，应通过显式数据迁移完成，而不是
在读取时静默猜测。
"""

from __future__ import annotations

# ---------------------------- 跨进程公开协议 ----------------------------
# 一轮 Agent 对话的公开响应。包含 answer、状态、精简 executions 和 presentations；
# 不包含 AgentContext、工具原始输入、FIT 路径或其他进程内状态。
AGENT_TURN_V1 = "agent_turn.v1"

# 单个 UI 展示块。具体组件通过 type 区分：markdown、metric_cards、
# line_chart、table、route_map。浏览器不需要认识活动分析的内部 result kind。
PRESENTATION_V1 = "presentation.v1"

# Rider/Node 请求 Python 导入一个 FIT 后得到的跨进程响应。
FIT_INGESTION_V1 = "fit_ingestion.v1"

# 可重建但会持久化缓存的活动详情，包括地图/图表需要的采样时序。HTTP 返回可动态
# 附加可选 ``report``，但生成报告不写入该 FIT artifact，避免报告晚于缓存生成时陈旧。
ACTIVITY_DETAIL_V1 = "activity_detail.v1"

# ---------------------------- 活动持久化协议 ----------------------------
# 以下两个对象目前共同保存在 activity_facts。metrics 是数值事实，features 是
# 冲刺、爬坡、强度片段等确定性候选。暂不合并版本，避免迁移现有 SQLite 数据。
ACTIVITY_METRICS_V2 = "activity_metrics.v2"
ACTIVITY_FEATURES_V1 = "activity_features.v1"

# SQLite activity_reports 中的完整权威分析报告。这里保留历史字符串；它与工具
# 内部的 kind=activity_report 不同，后者只是一次展示结果，不是存储格式。
ACTIVITY_REPORT_V2 = "llm_fit_file_analysis.v2"

# -------------------------- 可恢复业务状态协议 --------------------------
# 可持久化任务图：活动快照、任务依赖、尝试次数、失败与 pending_upload_id。
WORKFLOW_RUN_V1 = "workflow_run.v1"

# 分析会话的焦点/导航栈。常量使用业务名，值暂时兼容现有数据库命名。
ANALYSIS_WORKSPACE_V1 = "analysis_navigation.v1"

# 持久化的分析结果，可被 workspace 通过 result_id 再次引用。
ANALYSIS_RESULT_V1 = "analysis_result.v1"

# 路线计划包含候选、当前选择、确认状态和 revision，需要跨对话恢复及撤销。
ROUTE_PLAN_V1 = "route_plan.v1"

# Python RouteNarrationAgent 生成、Browser 校验并按骑行里程消费的讲解计划。
ROUTE_NARRATION_PLAN_V1 = "route_narration_plan.v1"

# FTP、体重、最大/静息心率等唯一运动员事实源。
ATHLETE_PROFILE_V1 = "athlete_profile.v1"

# 追加式可观测日志。日志读取器可能在升级后读取旧 trace，因此也需要版本。
AGENT_TRACE_V1 = "agent_trace.v1"

# PUBLIC_SCHEMAS 会直接跨 HTTP/进程边界。注意 activity_detail 同时也可缓存，
# 这里按它最主要的消费者边界归类；两个集合无需互斥表达全部属性。
PUBLIC_SCHEMAS = frozenset({AGENT_TURN_V1, PRESENTATION_V1, FIT_INGESTION_V1, ACTIVITY_DETAIL_V1})

# PERSISTED_SCHEMAS 在进程退出后仍要读取。修改这些格式前必须检查数据库迁移、
# 历史 JSON/缓存兼容和回滚策略。
PERSISTED_SCHEMAS = frozenset({
    ACTIVITY_METRICS_V2,
    ACTIVITY_FEATURES_V1,
    ACTIVITY_REPORT_V2,
    WORKFLOW_RUN_V1,
    ANALYSIS_WORKSPACE_V1,
    ANALYSIS_RESULT_V1,
    ROUTE_PLAN_V1,
    ROUTE_NARRATION_PLAN_V1,
    ATHLETE_PROFILE_V1,
    AGENT_TRACE_V1,
})

# 用于测试、文档和审计的完整白名单。生产代码不应根据这个集合动态猜测类型；
# 每个边界仍应使用对应的常量进行显式校验。
STABLE_SCHEMAS = PUBLIC_SCHEMAS | PERSISTED_SCHEMAS
