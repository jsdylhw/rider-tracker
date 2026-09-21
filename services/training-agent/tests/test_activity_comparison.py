from __future__ import annotations

from agent.tools.handlers.activity_insights import compare_selected_activities_tool
from agent.main_agent.context import AgentContext
from tests.report_store_helpers import store_report


def _store(root, *, key: str, label: str, distance_km: float, duration_min: float):
    return store_report(root, {
        "activity_key": key,
        "fit_summary": {
            "sport_type": "cycling",
            "start_time_local": f"2026-05-18T0{1 if key == 'a1' else 2}:00:00",
            "distance_m": distance_km * 1000,
            "duration_s": duration_min * 60,
        },
        "activity_metrics": {
            "schema_version": "activity_metrics.v2",
            "scale": {"distance_km": distance_km, "duration_min": duration_min},
        },
        "analysis_summary": {
            "summary_label": label,
            "main_stimulus": "低强度耐力",
            "load_label": "非常轻",
            "brief": f"{label} brief",
        },
    })


def test_compare_selected_activities_reads_database_reports(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    first = _store(tmp_path, key="a1", label="晨间轻松骑", distance_km=9.38, duration_min=26.9)
    second = _store(tmp_path, key="a2", label="夜间恢复骑", distance_km=15.79, duration_min=42.8)
    context = AgentContext(session_id="comparison-test", selected_activities=[first, second])

    result = compare_selected_activities_tool(context)

    assert result["status"] == "completed"
    assert result["result"]["count"] == 2
    assert result["result"]["totals"] == {"distance_km": 25.17, "duration_min": 69.7}
    assert result["result"]["highlights"]["longest_distance_activity_key"] == "a2"
    assert "没有重新解析 FIT" in result["answer"]


def test_compare_selected_activities_reports_missing_activity_facts(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    context = AgentContext(
        session_id="comparison-test",
        selected_activities=[{"activity_key": "a1"}, {"activity_key": "a2"}],
    )

    result = compare_selected_activities_tool(context)

    assert result["error"] == "not_enough_activity_facts"
    assert len(result["missing"]) == 2


def test_compare_selected_activities_uses_imported_facts_without_reports(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    from storage.repositories.activity import ActivityStore

    store = ActivityStore()
    selected = []
    for index, (key, started_at, distance_km, tss) in enumerate((
        ("facts-a", "2026-05-18T08:00:00", 10.0, 15.0),
        ("facts-b", "2026-05-19T08:00:00", 20.0, 40.0),
    ), start=1):
        activity = {
            "activity_key": key,
            "fit_path": str(tmp_path / f"{key}.fit"),
            "sport_type": "cycling",
            "start_time_local": started_at,
            "distance_km": distance_km,
            "duration_min": 30.0 * index,
        }
        store.upsert_activity(activity)
        store.save_facts(key, metrics={
            "schema_version": "activity_metrics.v2",
            "activity_key": key,
            "identity": {"sport_type": "cycling", "start_time_local": started_at},
            "scale": {"distance_km": distance_km, "duration_min": 30.0 * index},
            "power": {"intensity_factor": 0.6 + index * 0.1},
            "load": {"power_stress": {"tss": tss, "source": "fit_session"}},
        }, features={
            "schema_version": "activity_features.v1", "extractor_version": "test",
            "sprint_candidates": {}, "effort_candidates": {}, "climb_candidates": {},
        })
        selected.append(activity)

    result = compare_selected_activities_tool(AgentContext(session_id="facts-compare", selected_activities=selected))

    assert result["status"] == "completed"
    assert result["result"]["totals"]["distance_km"] == 30.0
    assert {item["metrics_source"] for item in result["result"]["activities"]} == {"stored_facts_v1"}
    assert "导入时结构化事实" in result["answer"]


def test_requested_metrics_reach_answer_and_missing_speed_is_not_derived(monkeypatch):
    from agent.tools.handlers.activity_insights import compare_activities
    facts = {
        "a": {"activity_key": "a", "scale": {"distance_km": 10, "duration_min": 30}, "performance": {"avg_speed_kmh": 24.5}},
        "b": {"activity_key": "b", "scale": {"distance_km": 20, "duration_min": 60}},
    }
    monkeypatch.setattr("services.activity.comparison.load_activity_metrics", lambda a: (facts[a['activity_key']], "stored_facts_v1", None))
    monkeypatch.setattr("services.activity.comparison.read_activity_report", lambda _: ({}, None))
    context = AgentContext(session_id="requested-compare", selected_activities=[{"activity_key": "a"}, {"activity_key": "b"}])
    result = compare_activities({"metrics": ["distance", "duration", "average_speed", "未知指标"]}, context)
    assert result["status"] == "completed"
    rows = result["result"]["metric_results"]
    assert rows[0]["metrics"]["average_speed"]["value"] == 24.5
    assert rows[1]["metrics"]["average_speed"]["status"] == "missing"
    assert rows[0]["metrics"]["未知指标"]["status"] == "unsupported"
    assert "平均速度：24.5 km/h" in result["answer"]
    assert "平均速度：无数据" in result["answer"]
    assert "暂不支持该指标" in result["answer"]
    assert "TSS" not in result["answer"]
