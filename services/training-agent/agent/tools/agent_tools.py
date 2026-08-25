"""Coarse Main Agent ToolDef catalogue."""

from __future__ import annotations

from agent.tools.spec import (
    CATEGORY_ACTIVITY_SELECTION,
    CATEGORY_ANALYSIS,
    CATEGORY_COACHING,
    CATEGORY_CONVERSATION,
    CATEGORY_OPERATION,
    CATEGORY_SKILL,
    CATEGORY_WORKFLOW,
    ToolDef,
)

MAIN_AGENT_TOOLS: tuple[ToolDef, ...] = (
    ToolDef(
        name="activate_skill",
        description=(
            "Activate exactly one registered domain skill for this user turn. "
            "Use it before any activity, Garmin, Strava, coaching or route task; "
            "ordinary conversation needs no skill."
        ),
        input_schema={
            "type": "object",
            "properties": {"skill_id": {"type": "string"}},
            "required": ["skill_id"],
        },
        category=CATEGORY_SKILL,
    ),
    # -- conversation --------------------------------------------------
    ToolDef(
        name="casual_chat",
        description="处理不需要活动数据的问候或普通聊天。",
        input_schema={
            "type": "object",
            "properties": {"answer": {"type": "string", "description": "预设回答"}},
        },
        category=CATEGORY_CONVERSATION,
    ),
    ToolDef(
        name="ask_user_clarification",
        description="请求范围或意图不明确时追问聚焦问题。",
        input_schema={
            "type": "object",
            "properties": {"question": {"type": "string", "description": "追问的问题"}},
        },
        category=CATEGORY_CONVERSATION,
    ),
    # -- activity ------------------------------------------------------
    ToolDef(
        name="resolve_activities",
        description=(
            "按显式 kind 从本地 SQLite 定位活动并冻结有序结果。"
            "recent=最近N条；date=指定日期内的活动；range=日期范围；all=全部；"
            "key/index/name=指定单条；current=复用当前焦点。不要混用不同 kind 的字段。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "kind": {
                    "type": "string",
                    "enum": ["current", "recent", "date", "range", "all", "key", "index", "name"],
                    "description": "选择类型；必须显式提供。",
                },
                "activity_key": {"type": "string"},
                "activity_index": {"type": "integer"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 1},
                "order": {
                    "type": "string",
                    "enum": ["latest", "earliest", "longest"],
                    "default": "latest",
                    "description": "longest 按活动时长从长到短排序。",
                },
                "date": {"type": "string", "description": "相对或 ISO 日期,如 today/yesterday/2026-05-18"},
                "name": {"type": "string"},
                "sport_type": {"type": "string", "description": "可传 cycling/running/walking，也接受 Ride、骑行、run、跑步等常见别名。"},
                "time_of_day": {
                    "type": "string",
                    "enum": ["morning", "afternoon", "evening", "night"],
                    "description": "按本地开始时间过滤；morning 为 04:00-11:59。",
                },
                "match": {"type": "string", "enum": ["latest", "earliest"], "default": "latest"},
                "start_date": {"type": "string", "description": "ISO date"},
                "end_date": {"type": "string", "description": "ISO date"},
                "relative_range": {"type": "string", "enum": ["this_week", "this_month", "last_week", "last_month"]},
                "days": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 3650,
                    "description": "最近 N 天（含今天），例如最近一个月可传 30。",
                },
            },
            "required": ["kind"],
        },
        category=CATEGORY_ACTIVITY_SELECTION,
    ),
    ToolDef(
        name="lookup_activities",
        description=(
            "按显式 kind 只读查询本地 SQLite 活动目录，不改变当前活动集合或导航焦点。"
            "用于在已建立的活动范围外补充查询、对照或查找全库最早/最新/最长活动；参数规则与 resolve_activities 相同。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "kind": {
                    "type": "string",
                    "enum": ["current", "recent", "date", "range", "all", "key", "index", "name"],
                    "description": "选择类型；必须显式提供。",
                },
                "activity_key": {"type": "string"},
                "activity_index": {"type": "integer"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 1},
                "order": {
                    "type": "string",
                    "enum": ["latest", "earliest", "longest"],
                    "default": "latest",
                    "description": "longest 按活动时长从长到短排序。",
                },
                "date": {"type": "string", "description": "相对或 ISO 日期,如 today/yesterday/2026-05-18"},
                "name": {"type": "string"},
                "sport_type": {"type": "string", "description": "可传 cycling/running/walking，也接受常见别名。"},
                "time_of_day": {"type": "string", "enum": ["morning", "afternoon", "evening", "night"]},
                "start_date": {"type": "string", "description": "ISO date"},
                "end_date": {"type": "string", "description": "ISO date"},
                "relative_range": {"type": "string", "enum": ["this_week", "this_month", "last_week", "last_month"]},
                "days": {"type": "integer", "minimum": 1, "maximum": 3650},
            },
            "required": ["kind"],
        },
        category=CATEGORY_ACTIVITY_SELECTION,
    ),
    ToolDef(
        name="find_segments",
        description=(
            "在当前单条活动内定位语义片段并保存导航焦点。"
            "sprint 使用短冲刺原子检测器；interval/effort/climb 使用持续区间扫描。"
            "只返回真实片段，不生成完整报告。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "segment_type": {
                    "type": "string",
                    "enum": ["sprint", "interval", "effort", "climb", "fast_running_segment"],
                },
                "ordinal": {"type": "integer", "minimum": 1},
                "window_seconds": {"type": "integer", "minimum": 10, "maximum": 180},
                "step_seconds": {"type": "integer", "minimum": 5, "maximum": 180},
                "max_segments": {"type": "integer", "minimum": 1, "maximum": 20, "default": 12},
            },
            "required": ["segment_type"],
        },
        category=CATEGORY_ANALYSIS,
    ),
    ToolDef(
        name="inspect_selection",
        description=(
            "轻量检查当前导航焦点。单活动复用 get_activity_overview；多活动读取结构化指标；"
            "片段焦点读取已定位片段，必要时复用 get_time_intervals。不会生成完整报告。"
        ),
        input_schema={"type": "object", "properties": {}},
        category=CATEGORY_ANALYSIS,
    ),
    ToolDef(
        name="analyze_selection",
        description=(
            "按结构化 objective 分析当前单活动、多活动或片段焦点。"
            "标准事实复用现有 FIT 原子工具；复杂定向问题才进入只读 ActivityAnalysisAgent。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "objective": {
                    "type": "string",
                    "enum": [
                        "inspect_activity", "evaluate_performance", "explain_power_drop",
                        "analyze_hr_drift", "analyze_pacing", "detect_intervals",
                        "compare_segments", "compare_activities", "summarize_training", "answer_question",
                    ],
                },
                "depth": {"type": "string", "enum": ["inspect", "deep"], "default": "inspect"},
                "metric_scope": {"type": "array", "items": {"type": "string"}},
                "question": {"type": "string"},
            },
            "required": ["objective"],
        },
        category=CATEGORY_ANALYSIS,
    ),
    ToolDef(
        name="navigate_selection",
        description=(
            "在已保存的活动集合或片段集合中选择序号、返回上一层或回到根范围。"
            "用于‘看第二个’、‘返回’、‘回到最近五次’等多轮指代。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["select", "back", "root", "current"]},
                "ordinal": {"type": "integer", "minimum": 1},
            },
            "required": ["action"],
        },
        category=CATEGORY_ACTIVITY_SELECTION,
    ),
    ToolDef(
        name="analyze_activity",
        description="读取已定位单条活动的完整报告；已有 summary 时直接返回，缺失时才生成。通常先调用 resolve_activities，且不能用于批量逐条分析。",
        input_schema={
            "type": "object",
            "properties": {
                "force": {"type": "boolean", "default": False, "description": "强制重新分析"},
            },
        },
        category=CATEGORY_ANALYSIS,
    ),
    ToolDef(
        name="query_activity_detail",
        description=(
            "回答单条活动必须读取 FIT 原始区间数据的定向问题，例如指定秒数、距离段、冲刺、爬升或分段。"
            "先定位且只能选中一条活动；此工具直接启动只读子 Agent 做定向查询，不要求也不覆盖完整报告。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "question": {"type": "string", "description": "需要 FIT 原始数据验证的具体问题"},
            },
            "required": ["question"],
        },
        category=CATEGORY_ANALYSIS,
    ),
    ToolDef(
        name="summarize_activities",
        description=(
            "只读汇总已定位的多条活动，使用导入时 facts 和已有报告；"
            "缺失完整报告时只标记覆盖率，不生成或刷新报告。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "response_mode": {"type": "string", "enum": ["ai_summary", "compact"], "default": "compact"},
                "detail_level": {"type": "string", "enum": ["normal", "detailed"], "default": "normal"},
            },
        },
        category=CATEGORY_ANALYSIS,
    ),
    ToolDef(
        name="compare_activities",
        description="多条活动横向对比，仅用于明确比较意图。",
        input_schema={"type": "object", "properties": {}},
        category=CATEGORY_ANALYSIS,
    ),
    ToolDef(
        name="summarize_recent_training_load",
        description="提取 TSS/IF 等结构化训练负荷。",
        input_schema={"type": "object", "properties": {}},
        category=CATEGORY_ANALYSIS,
    ),
    ToolDef(
        name="calculate_history_metrics",
        description=(
            "对已定位的多条活动计算确定性的历史指标和时间序列。"
            "用于周/月趋势、训练量变化、是否进步等问题；读取 activity_metrics，"
            "旧报告缺少结构化指标时只读解析 FIT，不从 LLM 报告文字提取数值。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "group_by": {
                    "type": "string",
                    "enum": ["day", "week", "month"],
                    "default": "week",
                    "description": "历史指标的时间分组粒度。",
                },
            },
        },
        category=CATEGORY_ANALYSIS,
    ),
    ToolDef(
        name="analyze_training_history",
        description=(
            "对已定位的多条活动生成专业、保守且可视化友好的历史分析。"
            "输出 training_history_analysis.v1，包含当前期/基线期、覆盖率、训练量/强度/规律性证据、"
            "不可用维度、置信度和趋势序列；不从报告文本提取数值。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "group_by": {
                    "type": "string",
                    "enum": ["day", "week", "month"],
                    "default": "week",
                },
                "sport_type": {
                    "type": "string",
                    "enum": ["cycling", "running", "walking"],
                    "description": "表现分析必须按运动类型筛选。",
                },
                "combine_sports_for_volume": {
                    "type": "boolean",
                    "default": False,
                    "description": "仅当用户明确询问跨运动总训练量时启用。",
                },
            },
        },
        category=CATEGORY_ANALYSIS,
    ),
    # -- coaching ------------------------------------------------------
    ToolDef(
        name="generate_training_advice",
        description="根据活动数据和历史生成下一次训练或周训练建议。",
        input_schema={"type": "object", "properties": {}},
        category=CATEGORY_COACHING,
    ),
    ToolDef(
        name="create_route_plan",
        description=(
            "统一创建并持久化单日路线。明确途经点时按给定骨架算路；开放需求由模型先给出至多三个"
            "骨架。国内使用高德，国外使用 Google Routes；默认尝试用真实 Strava 路段增强，"
            "失败时保留地图基线。complete_loop 用于围绕一个完整闭合 Strava 热门环线接驳往返。"
        ),
        input_schema={
            "type": "object",
            "required": ["title", "country_code"],
            "properties": {
                "title": {"type": "string"},
                "country_code": {"type": "string", "description": "ISO 两字母国家代码，如 CN、FR、JP"},
                "include_elevation": {"type": "boolean", "default": True},
                "segment_strategy": {
                    "type": "string", "enum": ["auto", "ignore", "require", "complete_loop"], "default": "auto",
                    "description": "auto 尝试 Strava 增强并在失败时保留地图基线；complete_loop 需要 origin 和 area。",
                },
                "segment_preferences": {
                    "type": "array", "items": {"type": "string"},
                    "description": "例如热门、湖景、少爬坡、经典爬坡。",
                },
                "origin": {"type": "string", "description": "complete_loop 的实际起终点。"},
                "area": {"type": "string", "description": "complete_loop 的环线检索区域。"},
                "segment_name_hint": {"type": "string", "description": "可选的热门环线名称片段。"},
                "target_distance_km": {
                    "type": "number", "minimum": 1,
                    "description": "仅当用户明确给出目标距离或距离范围时填写，不得自行估算。",
                },
                "search_radius_km": {"type": "number", "minimum": 0.5, "maximum": 20, "default": 8},
                "fallback_to_provider": {"type": "boolean", "default": True},
                "candidates": {
                    "type": "array", "minItems": 1, "maxItems": 3,
                    "items": {
                        "type": "object",
                        "required": ["name", "waypoints"],
                        "properties": {
                            "name": {"type": "string"},
                            "waypoints": {
                                "type": "array", "minItems": 2, "maxItems": 12,
                                "items": {"type": "string"},
                                "description": (
                                    "按顺序排列的真实地点检索词。用户明确给出 A 到 B 再到 C 时必须原样使用"
                                    " [A,B,C]，不得擅自补回 A；只有用户明确要求环线、返回起点或骑一圈时，"
                                    "才把起点原样重复为最后一点。"
                                ),
                            },
                            "target_distance_km": {
                                "type": "number",
                                "description": "仅当用户明确给出目标距离或距离范围时填写。",
                            },
                        },
                    },
                },
            },
        },
        category=CATEGORY_COACHING,
    ),
    ToolDef(
        name="create_itinerary_plan",
        description=(
            "创建并持久化经过地图服务验证的多日或单日上下午分段行程。"
            "每个候选由按顺序排列的 stages 组成，并校验相邻阶段的衔接距离。"
        ),
        input_schema={
            "type": "object",
            "required": ["title", "country_code", "schedule_type", "candidates"],
            "properties": {
                "title": {"type": "string"},
                "country_code": {"type": "string", "description": "ISO 两字母国家代码"},
                "schedule_type": {"type": "string", "enum": ["multi_day", "day_parts"]},
                "include_elevation": {"type": "boolean", "default": True},
                "segment_strategy": {
                    "type": "string", "enum": ["auto", "ignore", "require"], "default": "auto",
                },
                "segment_preferences": {"type": "array", "items": {"type": "string"}},
                "handoff_tolerance_km": {"type": "number", "minimum": 0, "default": 5},
                "balance_warning_ratio": {"type": "number", "minimum": 0, "default": 0.3},
                "candidates": {
                    "type": "array", "minItems": 1, "maxItems": 3,
                    "items": {
                        "type": "object",
                        "required": ["name", "stages"],
                        "properties": {
                            "name": {"type": "string"},
                            "stages": {
                                "type": "array", "minItems": 2, "maxItems": 7,
                                "items": {
                                    "type": "object",
                                    "required": ["label", "day", "period", "waypoints"],
                                    "properties": {
                                        "label": {"type": "string"},
                                        "day": {"type": "integer", "minimum": 1, "maximum": 7},
                                        "period": {
                                            "type": "string",
                                            "enum": ["full_day", "morning", "afternoon", "evening"],
                                        },
                                        "waypoints": {
                                            "type": "array", "minItems": 2, "maxItems": 12,
                                            "items": {"type": "string"},
                                            "description": (
                                                "明确点位按用户顺序原样保留；只有明确要求闭环时才重复首点。"
                                            ),
                                        },
                                        "target_distance_km": {"type": "number"},
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
        category=CATEGORY_COACHING,
    ),
    ToolDef(
        name="update_route_plan",
        description=(
            "更新最近或指定路线计划。replace_waypoints 更新单日路线，replace_stage "
            "更新完整阶段，replace_waypoint 替换一个途经点；reverse_candidate/reverse_stage "
            "确定性反转路线方向，select_candidate 切换预览候选，compose_segments 按已发现的 "
            "Strava 路段顺序生成路线，confirm_candidate 确认最终路线，undo 恢复上一版本。"
        ),
        input_schema={
            "type": "object",
            "required": ["operation"],
            "properties": {
                "plan_id": {"type": "string"},
                "operation": {
                    "type": "string",
                    "enum": [
                        "replace_waypoints", "replace_stage", "replace_waypoint",
                        "reverse_candidate", "reverse_stage", "select_candidate",
                        "compose_segments", "confirm_candidate", "undo",
                    ],
                },
                "candidate_id": {"type": "string"},
                "candidate_name": {"type": "string"},
                "stage_id": {"type": "string"},
                "stage_label": {"type": "string"},
                "waypoint_index": {
                    "type": "integer", "minimum": 1,
                    "description": "replace_waypoint 使用，按用户可见顺序从 1 开始",
                },
                "new_waypoint": {"type": "string", "description": "replace_waypoint 的新地点检索词"},
                "waypoints": {
                    "type": "array", "items": {"type": "string"}, "minItems": 2, "maxItems": 12,
                    "description": (
                        "replace_waypoints/replace_stage 使用；按用户给出的完整顺序原样传递。"
                        "首尾不同为单程，只有用户明确要求闭环时才重复首点。"
                    ),
                },
                "target_distance_km": {"type": "number"},
                "include_elevation": {"type": "boolean", "default": True},
                "segment_strategy": {
                    "type": "string", "enum": ["auto", "ignore", "require"],
                    "description": "缺省时沿用当前路线计划的策略。",
                },
                "segment_preferences": {"type": "array", "items": {"type": "string"}},
                "segments": {
                    "type": "array", "minItems": 1, "maxItems": 3,
                    "description": "compose_segments 使用；数组顺序就是骑行顺序，只能引用当前路线已发现的真实 Strava Segment ID。",
                    "items": {
                        "type": "object",
                        "required": ["segment_id"],
                        "properties": {
                            "segment_id": {"type": "integer", "minimum": 1},
                            "direction": {
                                "type": "string", "enum": ["auto", "forward", "reverse"], "default": "auto",
                            },
                        },
                    },
                },
            },
        },
        category=CATEGORY_COACHING,
    ),
    ToolDef(
        name="get_route_plan",
        description="读取最近或指定的已持久化路线计划，用于恢复会话或继续修改。",
        input_schema={
            "type": "object",
            "properties": {"plan_id": {"type": "string"}},
        },
        category=CATEGORY_COACHING,
    ),
    ToolDef(
        name="explore_route_segments",
        description=(
            "读取最近或指定的已保存路线，通过 Strava Segment Explorer 查询路线附近的热门骑行路段样本，"
            "并保存名称、距离、平均坡度、爬升分类和地图几何。不会自动改变已验证路线。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "plan_id": {"type": "string"},
                "candidate_id": {"type": "string", "description": "缺省时使用当前候选"},
                "stage_id": {"type": "string", "description": "多日或上下午行程可只查询一个阶段"},
                "corridor_km": {
                    "type": "number", "minimum": 0.1, "maximum": 20, "default": 5,
                    "description": "路段几何到计划路线的最大接近距离",
                },
                "max_segments": {
                    "type": "integer", "minimum": 1, "maximum": 20, "default": 12,
                },
            },
        },
        category=CATEGORY_COACHING,
    ),
    # -- operation -----------------------------------------------------
    ToolDef(
        name="sync_garmin_activities",
        description=(
            "只从 Garmin 下载最近活动并更新本地活动索引，然后结束。"
            "不会生成 summary、调用分析 Agent、上传 Strava 或创建 ActivityRun。"
            "用户只说同步/下载时使用此工具。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "count": {
                    "type": "integer", "minimum": 1, "maximum": 20,
                    "description": "必须严格等于用户要求的活动数量；最新一个/最后一个/最新一条必须为 1。",
                },
                "force_download": {
                    "type": "boolean", "default": False,
                    "description": "仅当用户明确要求刷新同一条 Garmin 活动的原始 FIT 时使用；新增活动不需要。",
                },
            },
            "required": ["count"],
        },
        category=CATEGORY_OPERATION,
    ),
    ToolDef(
        name="sync_and_run_activity_workflow",
        description=(
            "从 Garmin 同步最近活动后，严格只处理本次同步并成功索引的活动。"
            "可组合生成 summary、上传 Strava 和汇总；同步结果会冻结为持久化活动快照。"
            "仅在用户明确要求同步后继续分析、汇总或上传时使用；"
            "纯同步必须使用 sync_garmin_activities。不要把同步、分析和上传拆成对话中的多次调用。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "count": {
                    "type": "integer", "minimum": 1, "maximum": 20,
                    "description": "必须严格等于用户要求的活动数量；最新一个/最后一个/最新一条必须为 1。",
                },
                "force_download": {
                    "type": "boolean", "default": False,
                    "description": "重新下载本地已有的同一 Garmin 活动；不要把普通的新活动同步设为 true。",
                },
                "goals": {
                    "type": "array",
                    "items": {"type": "string", "enum": ["ensure_summary", "upload_strava", "aggregate_report"]},
                },
                "force": {"type": "boolean", "default": False},
                "force_upload": {"type": "boolean", "default": False},
            },
            "required": ["count", "goals"],
        },
        category=CATEGORY_WORKFLOW,
    ),
    # -- persistent activity workflow --------------------------------
    ToolDef(
        name="run_activity_workflow",
        description=(
            "对本地已存在的多条活动创建并推进持久化工作流。"
            "可组合生成单条 summary、上传 Strava、汇总；任务状态会持久化，可在失败后重试。"
            "本地已有活动无需同步 Garmin。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 5},
                "order": {"type": "string", "enum": ["latest", "earliest"], "default": "latest"},
                "sport_type": {"type": "string"},
                "goals": {
                    "type": "array",
                    "items": {"type": "string", "enum": ["ensure_summary", "upload_strava", "aggregate_report"]},
                    "description": "目标可组合；upload_strava 和 aggregate_report 会自动依赖 ensure_summary。",
                },
                "force": {"type": "boolean", "default": False, "description": "重新生成已有 summary"},
                "force_upload": {"type": "boolean", "default": False, "description": "重复活动时更新 Strava 描述"},
            },
        },
        category=CATEGORY_WORKFLOW,
    ),
    ToolDef(
        name="rebuild_activity_reports",
        description=(
            "在后台把本地活动重新生成并写入 activity_reports 的 V2 报告。"
            "用户明确说重新分析全部/所有活动时使用；提交后立即返回 job_id，不阻塞聊天。"
            "scope=all 强制重建全部，scope=outdated 只处理没有 V2 报告的活动。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "scope": {"type": "string", "enum": ["all", "outdated"], "default": "all"},
            },
        },
        category=CATEGORY_WORKFLOW,
    ),
    ToolDef(
        name="get_activity_report_job",
        description="查看后台 V2 报告重建任务的进度和逐活动结果；不会启动新分析。",
        input_schema={
            "type": "object",
            "properties": {"job_id": {"type": "string"}},
            "required": ["job_id"],
        },
        category=CATEGORY_WORKFLOW,
    ),
    ToolDef(
        name="get_activity_workflow",
        description="读取持久化活动工作流的真实状态和任务结果；不执行操作。",
        input_schema={
            "type": "object",
            "properties": {"workflow_id": {"type": "string"}},
            "required": ["workflow_id"],
        },
        category=CATEGORY_WORKFLOW,
    ),
    ToolDef(
        name="retry_activity_workflow",
        description=(
            "重试一个工作流中失败的任务；会恢复因其失败被跳过的下游任务和旧的 partial 汇总。"
            "重试会直接推进可恢复的任务。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "workflow_id": {"type": "string"},
                "task_ids": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["workflow_id"],
        },
        category=CATEGORY_WORKFLOW,
    ),
)

# Backward-compatible export name for existing imports.
AGENT_TOOLS = MAIN_AGENT_TOOLS
