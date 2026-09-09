from __future__ import annotations

from agent.tools.handlers.activity_reporting import (
    query_selected_activity_detail_tool,
    show_selected_activity_report_tool,
)
from agent.main_agent.context import AgentContext
from storage.repositories.activity import ActivityStore
from tests.report_store_helpers import store_report


def test_show_selected_activity_report_reads_database_report(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    activity = store_report(tmp_path, {
        "activity_key": "a1",
        "markdown_report": "# 最新骑行报告\n\n这是一份已有报告。",
    })
    context = AgentContext(session_id="report-test", selected_activities=[activity])

    result = show_selected_activity_report_tool(context)

    assert result["status"] == "completed"
    assert result["answer"].startswith("# 最新骑行报告")
    assert result["result"]["source"] == "existing_report"


def test_detail_query_uses_read_only_child_agent(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    activity = store_report(tmp_path, {"activity_key": "a1", "markdown_report": "# 通用报告"})
    calls = []

    def fake_query(fit_path: str, **kwargs):
        calls.append((fit_path, kwargs))
        return {
            "activity_key": "a1",
            "fit_path": fit_path,
            "answer": "# 短冲刺检查",
            "status": "answered_query",
            "evidence": [{"label": "窗口", "value": "100-200s"}],
            "limitations": [],
        }

    monkeypatch.setattr("agent.tools.handlers.activity_reporting.run_activity_query_agent", fake_query)
    context = AgentContext(session_id="query-test", selected_activities=[activity])

    result = query_selected_activity_detail_tool(context, question="检查 100-200 秒是否有短冲刺")

    assert result["answer"] == "# 短冲刺检查"
    assert calls[0][1] == {"question": "检查 100-200 秒是否有短冲刺"}
    assert result["result"]["source"] == "targeted_query"
    assert result["result"]["agent"] == "ActivityQueryAgent"


def test_detail_query_does_not_generate_full_report_when_missing(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    fit = tmp_path / "a1.fit"
    fit.write_bytes(b"fit")
    calls = []

    def fake_query(fit_path: str, **kwargs):
        calls.append(kwargs)
        return {
            "activity_key": "a1",
            "fit_path": fit_path,
            "answer": "# 定向回答",
            "status": "answered_query",
        }

    monkeypatch.setattr("agent.tools.handlers.activity_reporting.run_activity_query_agent", fake_query)
    context = AgentContext(
        session_id="focused-without-report",
        selected_activities=[{"activity_key": "a1", "fit_path": str(fit)}],
    )

    result = query_selected_activity_detail_tool(context, question="看心率漂移")

    assert result["answer"] == "# 定向回答"
    assert calls == [{"question": "看心率漂移"}]
    assert ActivityStore().get_report("a1") is None


def test_show_report_generates_when_database_report_is_missing(monkeypatch):
    monkeypatch.setattr(
        "agent.tools.handlers.activity_reporting.run_activity_analysis_agent",
        lambda fit_path, **kwargs: {
            "activity_key": "a1",
            "fit_path": fit_path,
            "markdown_report": "# 新报告",
            "status": "analyzed",
            "agent": "ActivityAnalysisAgent",
        },
    )
    context = AgentContext(
        session_id="generate-test",
        selected_activities=[{"activity_key": "a1", "fit_path": "/tmp/a1.fit"}],
    )

    result = show_selected_activity_report_tool(context)

    assert result["status"] == "completed"
    assert result["answer"] == "# 新报告"
    assert result["result"]["source"] == "generated_summary"


def test_force_refreshes_existing_database_report(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    activity = store_report(tmp_path, {"activity_key": "a1", "markdown_report": "# 旧报告"})
    calls = []

    def fake_analyze(fit_path: str, **kwargs):
        calls.append((fit_path, kwargs))
        return {
            "activity_key": "a1",
            "fit_path": fit_path,
            "markdown_report": "# 刷新报告",
            "status": "analyzed",
            "agent": "ActivityAnalysisAgent",
        }

    monkeypatch.setattr("agent.tools.handlers.activity_reporting.run_activity_analysis_agent", fake_analyze)
    context = AgentContext(session_id="refresh-test", selected_activities=[activity])

    result = show_selected_activity_report_tool(
        context,
        args={"force": True, "user_request": "重新分析"},
    )

    assert result["answer"] == "# 刷新报告"
    assert calls[0][1] == {"force": True, "user_request": "重新分析"}


def test_missing_report_and_fit_is_explicit_error(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    context = AgentContext(session_id="missing-test", selected_activities=[{"activity_key": "a1"}])

    result = show_selected_activity_report_tool(context)

    assert result["error"] == "missing_activity_summary"
