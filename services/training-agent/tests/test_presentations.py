from __future__ import annotations

from agent.runtime.models import ToolExecution, TurnResult
from agent.runtime.presentation_projector import project_presentations


def _history_execution() -> ToolExecution:
    return ToolExecution(
        index=1,
        tool="analyze_training_history",
        input={"private_path": "/tmp/activity.fit"},
        result={
            "status": "completed",
            "result": {
                "schema_version": "training_history_analysis.v1",
                "dimensions": [{
                    "name": "volume",
                    "confidence": "medium",
                    "evidence": [{
                        "metric": "duration_min",
                        "baseline": 120,
                        "current": 150,
                        "percent_change": 25,
                        "unit": "min",
                    }],
                }],
                "series": {
                    "periods": [
                        {"period": "2026-W19", "totals": {"duration_min": 120, "tss": 80}},
                        {"period": "2026-W20", "totals": {"duration_min": 150, "tss": 110}},
                    ],
                },
                "view": {"chart_metrics": ["duration_min", "distance_km", "tss"]},
                "conclusion": {
                    "summary": "训练量有所增加，但暂不能判断体能变化。",
                    "confidence": "low",
                },
                "warnings": ["缺少匹配路线或标准化训练证据。"],
                "recommended_next_check": "继续积累可比训练。",
            },
        },
    )


def test_history_projector_uses_deterministic_result_values():
    blocks = project_presentations([_history_execution()])

    assert [block.type for block in blocks] == ["markdown", "table", "line_chart"]
    assert blocks[0].data["markdown"] == (
        "## 结论\n"
        "训练量有所增加，但暂不能判断体能变化。\n"
        "**可信度：** 低\n\n"
        "## 注意事项\n"
        "- 缺少匹配路线或标准化训练证据。\n\n"
        "## 下一步\n"
        "继续积累可比训练。"
    )
    assert blocks[1].data["rows"] == [{
        "dimension": "volume",
        "metric": "duration_min",
        "baseline": 120,
        "current": 150,
        "change": 25,
        "unit": "min",
        "confidence": "medium",
    }]
    assert blocks[2].data == {
        "x_label": "训练周期",
        "labels": ["2026-W19", "2026-W20"],
        "series": [
            {"metric": "duration_min", "unit": "min", "values": [120, 150]},
            {"metric": "tss", "unit": "TSS", "values": [80, 110]},
        ],
    }


def test_history_projector_omits_dimensions_without_evidence():
    execution = _history_execution()
    execution.result["result"]["dimensions"].append({
        "name": "recovery", "confidence": "low", "evidence": [],
    })

    blocks = project_presentations([execution])

    assert len(blocks[1].data["rows"]) == 1
    assert all(row["dimension"] != "recovery" for row in blocks[1].data["rows"])


def test_history_projector_omits_empty_summary_block():
    execution = _history_execution()
    payload = execution.result["result"]
    payload["conclusion"] = {}
    payload["warnings"] = []
    payload["recommended_next_check"] = ""

    blocks = project_presentations([execution])

    assert [block.type for block in blocks] == ["table", "line_chart"]


def test_public_turn_result_excludes_internal_state_and_raw_tool_values():
    execution = _history_execution()
    presentations = project_presentations([execution])
    result = TurnResult(
        answer="完成",
        status="completed",
        context={"secret": "internal"},
        intent="training_history",
        executions=[execution],
        presentations=presentations,
        current_fit_file="/tmp/activity.fit",
    ).to_public_dict()

    assert result["answer"] == "完成"
    assert "context" not in result
    assert "current_fit_file" not in result
    assert "input" not in result["executions"][0]
    assert "result" not in result["executions"][0]
    assert "/tmp/activity.fit" not in str(result)


def test_activity_report_projects_markdown_without_exposing_report_metadata():
    execution = ToolExecution(
        index=2,
        tool="analyze_activity",
        result={
            "status": "completed",
            "answer": "# 骑行报告\n\n状态良好。",
            "result": {
                "schema_version": "activity_report.v1",
                "fit_path": "/private/activity.fit",
                "activity_key": "activity-1",
                "fit_summary": {
                    "sport_type": "cycling",
                    "start_time_local": "2026-08-18T08:00:00+08:00",
                    "duration_s": 3660,
                    "distance_m": 25120,
                },
            },
        },
    )

    blocks = project_presentations([execution])

    assert [block.type for block in blocks] == ["metric_cards", "markdown"]
    assert blocks[0].data == {"items": [
        {"metric": "sport_type", "value": "cycling", "unit": ""},
        {"metric": "start_time_local", "value": "2026-08-18T08:00:00+08:00", "unit": ""},
        {"metric": "duration_min", "value": 61.0, "unit": "min"},
        {"metric": "distance_km", "value": 25.12, "unit": "km"},
    ]}
    assert blocks[1].data == {"markdown": "# 骑行报告\n\n状态良好。"}
    assert "/private/activity.fit" not in str([block.to_dict() for block in blocks])


def test_activity_report_projects_local_profile_after_llm_execution(monkeypatch):
    monkeypatch.setattr(
        "agent.runtime.presentation_projector.build_activity_profile",
        lambda path: {
            "x_label": "经过时间",
            "labels": ["0:00", "30:00"],
            "series": [{
                "metric": "cumulative_distance_km", "unit": "km", "values": [0.0, 12.5],
            }],
        },
    )
    execution = ToolExecution(
        index=3,
        tool="analyze_activity",
        result={
            "answer": "活动完成。",
            "result": {
                "schema_version": "activity_report.v1",
                "fit_path": "/private/activity.fit",
            },
        },
    )

    blocks = project_presentations([execution])

    assert [block.type for block in blocks] == ["line_chart", "markdown"]
    assert blocks[0].title == "活动过程曲线"
    assert blocks[0].data["series"][0]["values"] == [0.0, 12.5]


def test_single_resolved_activity_projects_details_without_analyze_tool(monkeypatch):
    monkeypatch.setattr(
        "agent.runtime.presentation_projector.build_activity_profile",
        lambda path: {
            "x_label": "经过时间",
            "labels": ["0:00", "1:00:00"],
            "series": [
                {"metric": "cumulative_distance_km", "unit": "km", "values": [0.0, 52.8]},
                {"metric": "heart_rate_bpm", "unit": "bpm", "values": [118.0, 152.0]},
            ],
        },
    )
    execution = ToolExecution(
        index=0,
        tool="resolve_activities",
        result={"result": {
            "schema_version": "activity_selection.v2",
            "count": 1,
            "activities": [{
                "summary_label": "长距离骑行",
                "sport_type": "cycling",
                "start_time_local": "2026-08-01T18:45:13",
                "duration_min": 105.5,
                "distance_km": 52.8,
                "fit_path": "/private/long.fit",
            }],
        }},
    )

    blocks = project_presentations([execution])

    assert [block.type for block in blocks] == ["metric_cards", "line_chart"]
    assert blocks[0].data["items"][0] == {
        "metric": "summary_label", "value": "长距离骑行", "unit": "",
    }
    assert blocks[1].data["series"][1]["metric"] == "heart_rate_bpm"
    assert "/private/long.fit" not in str([block.to_dict() for block in blocks])


def test_activity_report_replaces_resolved_activity_preview(monkeypatch):
    monkeypatch.setattr(
        "agent.runtime.presentation_projector.build_activity_profile",
        lambda path: {},
    )
    resolved = ToolExecution(
        index=0,
        tool="resolve_activities",
        result={"result": {
            "schema_version": "activity_selection.v2",
            "activities": [{"summary_label": "长距离骑行", "duration_min": 105.5}],
        }},
    )
    report = ToolExecution(
        index=1,
        tool="analyze_activity",
        result={
            "answer": "# 完整报告",
            "result": {"schema_version": "activity_report.v1"},
        },
    )

    blocks = project_presentations([resolved, report])

    assert [block.type for block in blocks] == ["markdown"]


def test_inspect_selection_projects_single_activity_facts_and_profile(monkeypatch):
    monkeypatch.setattr(
        "agent.runtime.presentation_projector.build_activity_profile",
        lambda path: {
            "x_label": "经过时间",
            "labels": ["0:00", "30:00"],
            "series": [{"metric": "heart_rate_bpm", "unit": "bpm", "values": [110, 145]}],
        },
    )
    execution = ToolExecution(
        index=4,
        tool="inspect_selection",
        result={"result": {
            "schema_version": "analysis_result.v1",
            "analysis": {
                "source": "activity_facts",
                "metrics": {
                    "schema_version": "activity_metrics.v2",
                    "fit_path": "/private/selected.fit",
                    "identity": {
                        "sport_type": "cycling",
                        "start_time_local": "2026-08-18T08:00:00+08:00",
                    },
                    "scale": {"duration_min": 30, "distance_km": 12.5},
                },
            },
        }},
    )

    blocks = project_presentations([execution])

    assert [block.type for block in blocks] == ["metric_cards", "line_chart"]
    assert blocks[0].data["items"][-1] == {"metric": "distance_km", "value": 12.5, "unit": "km"}
    assert blocks[1].data["series"][0]["metric"] == "heart_rate_bpm"
    assert "/private/selected.fit" not in str([block.to_dict() for block in blocks])


def test_activity_comparison_projects_totals_and_nonempty_columns():
    execution = ToolExecution(
        index=5,
        tool="compare_activities",
        result={"result": {
            "schema_version": "activity_comparison.v1",
            "count": 2,
            "totals": {"duration_min": 90, "distance_km": 42.5},
            "activities": [
                {
                    "activity_key": "internal-a",
                    "fit_path": "/private/a.fit",
                    "start_time_local": "2026-08-17T08:00:00",
                    "summary_label": "恢复骑",
                    "duration_min": 30,
                    "distance_km": 12.5,
                    "tss": None,
                },
                {
                    "activity_key": "internal-b",
                    "fit_path": "/private/b.fit",
                    "start_time_local": "2026-08-18T08:00:00",
                    "summary_label": "耐力骑",
                    "duration_min": 60,
                    "distance_km": 30,
                    "tss": None,
                },
            ],
        }},
    )

    blocks = project_presentations([execution])

    assert [block.type for block in blocks] == ["metric_cards", "table"]
    assert blocks[0].data["items"][0] == {"metric": "activity_count", "value": 2, "unit": "条"}
    assert "tss" not in blocks[1].data["columns"]
    public_blocks = str([block.to_dict() for block in blocks])
    assert "internal-a" not in public_blocks
    assert "/private/a.fit" not in public_blocks
