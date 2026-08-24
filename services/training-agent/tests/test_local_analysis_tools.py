from __future__ import annotations

import pytest

from agent.analysis.prompts import (
    FIT_ANALYSIS_CORE,
    FIT_ANALYSIS_OUTPUT_CONTRACT,
    FIT_ANALYSIS_TOOL_GUIDANCE,
    build_fit_analysis_system_prompt,
)
from agent.analysis.agent import (
    _extract_json_object,
    analyze_with_llm,
    analyze_fit_file,
    build_initial_loop_payload,
    choose_strava_summary_tone,
    normalize_analysis_submission,
)
from agent.tools import call_fit_analysis_tool, fit_data_tool_catalog
from fit.analysis.data import (
    DEFAULT_SECTIONS,
    SUMMARY_SECTIONS,
    _normalize_summary_sections,
    get_activity_overview_tool,
    get_activity_summary_tool,
)
from agent.tools.fit_analysis.catalog import SUBMIT_ANALYSIS_TOOL
from fit.analysis.stats import (
    _normalize_bucket_distance_m,
    _normalize_bucket_seconds,
    _round_float,
    _seconds_to_minutes,
    prune_empty_values,
)


class TestRoundFloat:
    def test_round_number(self):
        assert _round_float(3.14159, 2) == 3.14

    def test_round_none_returns_none(self):
        assert _round_float(None) is None

    def test_round_string_number(self):
        assert _round_float("3.14", 1) == 3.1

    def test_round_invalid_string(self):
        assert _round_float("abc") is None


class TestPruneEmptyValues:
    def test_removes_none_values(self):
        assert prune_empty_values({"a": 1, "b": None}) == {"a": 1}

    def test_removes_empty_dict(self):
        assert prune_empty_values({"a": 1, "b": {}}) == {"a": 1}

    def test_removes_empty_list(self):
        assert prune_empty_values({"a": 1, "b": []}) == {"a": 1}

    def test_keeps_zero_and_false(self):
        assert prune_empty_values({"a": 0, "b": False, "c": ""}) == {"a": 0, "b": False, "c": ""}

    def test_nested_pruning(self):
        result = prune_empty_values({"a": {"b": None, "c": 1}, "d": [None, {}, 2]})
        assert result == {"a": {"c": 1}, "d": [2]}

    def test_plain_value_passes_through(self):
        assert prune_empty_values(42) == 42
        assert prune_empty_values("hello") == "hello"


class TestExtractJsonObject:
    def test_plain_json_object(self):
        result = _extract_json_object('{"action": "final", "markdown_report": "hi"}')
        assert result["action"] == "final"

    def test_json_in_markdown_fence(self):
        text = '```json\n{"action": "tool", "tool": "get_history"}\n```'
        result = _extract_json_object(text)
        assert result["action"] == "tool"

    def test_json_with_surrounding_text(self):
        text = 'Some prefix text {"action": "final"} trailing text'
        result = _extract_json_object(text)
        assert result["action"] == "final"

    def test_invalid_json_raises(self):
        with pytest.raises(Exception):
            _extract_json_object("not json at all {broken")

    def test_array_raises(self):
        with pytest.raises(RuntimeError, match="JSON object"):
            _extract_json_object("[1, 2, 3]")

    def test_final_jsonish_with_raw_quotes_in_markdown(self):
        text = '''好的，最终输出如下:

```json
{
  "action": "final",
  "markdown_report": "# 报告\\n\\n这是主课前的"唤醒"，随后进入阈值段。",
  "strava_summary": "短距离阈值训练，主区间质量不错。",
  "analysis_summary": {
    "summary_label": "短距阈值训练"
  }
}
```'''

        result = _extract_json_object(text)

        assert result["action"] == "final"
        assert '主课前的"唤醒"' in result["markdown_report"]
        assert result["strava_summary"].startswith("短距离")
        assert result["analysis_summary"]["summary_label"] == "短距阈值训练"


class TestNormalizeBucketSeconds:
    def test_valid_value(self):
        assert _normalize_bucket_seconds(30) == 30

    def test_below_minimum_clamps_to_1(self):
        assert _normalize_bucket_seconds(0) == 1
        assert _normalize_bucket_seconds(-5) == 1

    def test_above_maximum_clamps_to_600(self):
        assert _normalize_bucket_seconds(1000) == 600

    def test_invalid_input_defaults_to_60(self):
        assert _normalize_bucket_seconds("abc") == 60

    def test_none_defaults_to_60(self):
        assert _normalize_bucket_seconds(None) == 60


class TestNormalizeBucketDistance:
    def test_exact_allowed_value(self):
        assert _normalize_bucket_distance_m(1000) == 1000
        assert _normalize_bucket_distance_m(3000) == 3000

    def test_rounds_to_nearest_allowed(self):
        assert _normalize_bucket_distance_m(900) == 1000
        assert _normalize_bucket_distance_m(2500) == 3000

    def test_invalid_defaults_to_1000(self):
        assert _normalize_bucket_distance_m("abc") == 1000

    def test_float_conversion(self):
        assert _normalize_bucket_distance_m("500.0") == 500


class TestNormalizeSummarySections:
    def test_empty_returns_defaults(self):
        result = _normalize_summary_sections(None)
        assert len(result) == len(DEFAULT_SECTIONS)
        assert "activity_identity" in result
        assert "training_zones" not in result  # not in defaults

    def test_all_returns_all(self):
        result = _normalize_summary_sections("all")
        assert len(result) == len(SUMMARY_SECTIONS)
        assert "training_zones" in result

    def test_specific_sections(self):
        result = _normalize_summary_sections(["power", "heart_rate"])
        assert result == ["power", "heart_rate"]

    def test_invalid_section_filtered_out(self):
        result = _normalize_summary_sections(["power", "nonexistent"])
        assert result == ["power"]

    def test_comma_string(self):
        result = _normalize_summary_sections("power, heart_rate")
        assert result == ["power", "heart_rate"]


class TestSecondsToMinutes:
    def test_conversion(self):
        assert _seconds_to_minutes(60) == 1.0
        assert _seconds_to_minutes(90) == 1.5

    def test_none_returns_none(self):
        assert _seconds_to_minutes(None) is None


class TestChooseStravaSummaryTone:
    def test_returns_dict_without_weight(self):
        tone = choose_strava_summary_tone()
        assert isinstance(tone, dict)
        assert "name" in tone
        assert "description" in tone
        assert "weight" not in tone

    def test_name_is_valid(self):
        valid_names = {"training_log", "professional_coach", "minimal_brief", "soft_catgirl"}
        tone = choose_strava_summary_tone()
        assert tone["name"] in valid_names


class TestFitAnalysisToolCatalog:
    def test_data_catalog_has_only_raw_detail_tools(self):
        """Whole-activity facts are precomputed; child tools inspect raw detail only."""
        tools = fit_data_tool_catalog()
        tool_names = {t["name"] for t in tools}
        assert tool_names == {
            "get_time_intervals", "get_distance_intervals", "get_running_efficiency", "get_history",
        }

    def test_no_side_effect_tools_in_data_catalog(self, sample_parsed_fit):
        """确认 sync/upload 不在 data catalog 中,analyze-file 不会触发副作用."""
        data_tools = {t["name"] for t in fit_data_tool_catalog()}
        assert "sync_garmin_activities" not in data_tools
        assert "upload_to_strava" not in data_tools
        assert "analyze_fit_file" not in data_tools

    def test_each_tool_has_description(self):
        for tool in fit_data_tool_catalog():
            assert "description" in tool
            assert len(tool["description"]) > 0

    def test_each_tool_has_input_schema(self):
        """ToolDef 每个工具返回 Anthropic 格式: name + description + input_schema."""
        for tool in fit_data_tool_catalog():
            assert "name" in tool
            assert "input_schema" in tool
            assert "description" in tool, f"{tool['name']} missing description"
            assert len(tool["description"]) > 20, f"{tool['name']} description too short"


class TestFitAnalysisPrompt:
    """验证模块化 system prompt 组装."""

    def test_sections_are_non_empty(self):
        assert len(FIT_ANALYSIS_CORE.strip()) > 0
        assert len(FIT_ANALYSIS_TOOL_GUIDANCE.strip()) > 0
        assert len(FIT_ANALYSIS_OUTPUT_CONTRACT.strip()) > 0

    def test_build_contains_all_sections(self):
        prompt = build_fit_analysis_system_prompt()
        assert "endurance training analysis assistant" in prompt
        assert "activity_metrics" in prompt
        assert "markdown_report" in prompt
        assert "strava_summary" in prompt

    def test_llm_fit_analysis_system_prompt_is_built(self):
        from agent.analysis.prompts import LLM_FIT_ANALYSIS_SYSTEM_PROMPT
        assert len(LLM_FIT_ANALYSIS_SYSTEM_PROMPT) > 0
        assert LLM_FIT_ANALYSIS_SYSTEM_PROMPT == build_fit_analysis_system_prompt()


class TestActivityIndex:
    def test_upsert_and_resolve_activity_from_fit(self, tmp_path, monkeypatch, sample_parsed_fit):
        monkeypatch.chdir(tmp_path)
        from services.activity.catalog import (
            get_activities_in_range,
            list_activities,
            resolve_activity,
            upsert_activity_from_fit,
        )

        fit_file = tmp_path / "ride.fit"
        fit_file.write_bytes(b"mock fit")
        index_path = tmp_path / "data" / "activity_index.json"
        monkeypatch.setattr("services.activity.catalog.parse_fit", lambda path: sample_parsed_fit)

        entry = upsert_activity_from_fit(fit_file, path=index_path)

        assert entry["file_name"] == "ride.fit"
        assert entry["date_local"] == "2026-05-14"
        listed = list_activities(path=index_path)
        assert listed["count"] == 1
        assert listed["activities"][0]["activity_index"] == 1
        resolved = resolve_activity(date_local="2026-05-14", path=index_path)
        assert resolved["matched_count"] == 1
        assert resolved["activity"]["fit_path"] == "ride.fit"
        ranged = get_activities_in_range(start_date="2026-05-01", end_date="2026-05-31", path=index_path)
        assert ranged["count"] == 1
        assert ranged["totals"]["distance_km"] == 5.0

    def test_fit_upsert_replaces_stale_path_identity(self, tmp_path, monkeypatch, sample_parsed_fit):
        monkeypatch.chdir(tmp_path)
        from services.activity.catalog import (
            load_activity_index,
            upsert_activity_entry,
            upsert_activity_from_fit,
        )

        fit_file = tmp_path / "ride.fit"
        fit_file.write_bytes(b"mock fit")
        index_path = tmp_path / "data" / "activity_index.json"
        monkeypatch.setattr("services.activity.catalog.parse_fit", lambda path: sample_parsed_fit)
        upsert_activity_entry(
            {
                "activity_key": "same",
                "fit_path": "ride.fit",
                "sport_type": "unknown",
            },
            path=index_path,
        )

        upsert_activity_from_fit(fit_file, path=index_path)

        row = load_activity_index(index_path)["activities"][0]
        assert row["activity_key"] != "same"
        assert row["sport_type"] == "cycling"
        assert row["has_summary"] is False
        assert "summary_path" not in row


class TestCallFitAnalysisTool:
    def test_unknown_tool_returns_error(self, sample_parsed_fit):
        result = call_fit_analysis_tool("nonexistent_tool", {}, parsed=sample_parsed_fit, history_before=None)
        assert result["error"] == "unknown_tool"

    def test_get_activity_overview(self, sample_parsed_fit):
        result = call_fit_analysis_tool("get_activity_overview", {}, parsed=sample_parsed_fit, history_before=None)
        assert result["tool"] == "get_activity_overview"
        overview = result["result"]
        assert overview["activity_identity"]["sport_type"] == "cycling"
        assert overview["scale"]["duration_min"] is not None

    def test_get_activity_summary(self, sample_parsed_fit):
        result = call_fit_analysis_tool("get_activity_summary", {"sections": ["power"]}, parsed=sample_parsed_fit, history_before=None)
        assert "result" in result
        assert "power" in result["result"]

    def test_get_time_intervals(self, sample_parsed_fit):
        result = call_fit_analysis_tool("get_time_intervals", {"bucket_seconds": 60}, parsed=sample_parsed_fit, history_before=None)
        assert result["result"]["available"] is True

    def test_get_distance_intervals(self, sample_parsed_fit):
        result = call_fit_analysis_tool("get_distance_intervals", {"bucket_distance_m": 1000}, parsed=sample_parsed_fit, history_before=None)
        assert result["result"]["available"] is True

    def test_scan_activity_segments(self, sample_parsed_fit):
        result = call_fit_analysis_tool("scan_activity_segments", {}, parsed=sample_parsed_fit, history_before=None)
        assert result["tool"] == "scan_activity_segments"
        assert result["result"]["available"] is True
        assert result["result"]["schema_version"] == "activity_scan.v1"

    def test_get_history_disabled(self, sample_parsed_fit):
        result = call_fit_analysis_tool("get_history", {}, parsed=sample_parsed_fit, history_before=None)
        assert result["result"]["count"] == 0

    def test_get_history_with_data(self, sample_parsed_fit):
        history = {"schema_version": "v1", "count": 2, "activities": [{"start_time": "2026-05-10T00:00:00+00:00"}]}
        result = call_fit_analysis_tool("get_history", {}, parsed=sample_parsed_fit, history_before=history)
        assert result["result"]["count"] == 2


class TestGetActivityOverviewTool:
    def test_returns_expected_structure(self, sample_parsed_fit):
        result = get_activity_overview_tool(sample_parsed_fit)
        assert result["activity_identity"]["sport_type"] == "cycling"
        assert result["activity_identity"]["start_time_local"] == "2026-05-14T16:00:00"
        assert "start_time_utc" not in result["activity_identity"]
        assert "duration_min" in result["scale"]
        assert "distance_km" in result["scale"]
        assert "total_ascent_m" in result["scale"]
        assert "avg_power_w" in result["basic_metrics"]
        assert "has_power" in result["data_availability"]

    def test_no_records_no_crash(self):
        parsed = {"summary": {}, "sessions": [], "sports": [], "records": [], "laps": [], "training_metadata": {}}
        result = get_activity_overview_tool(parsed)
        assert result["activity_identity"]["sport_type"] is None
        assert result["scale"]["duration_min"] is None


class TestGetActivitySummaryTool:
    def test_all_sections(self, sample_parsed_fit):
        result = get_activity_summary_tool(sample_parsed_fit, sections="all")
        assert "activity_identity" in result
        assert "power" in result
        assert "heart_rate" in result
        assert "cadence" in result
        assert "speed" in result
        assert "elevation" in result

    def test_single_section(self, sample_parsed_fit):
        result = get_activity_summary_tool(sample_parsed_fit, sections=["power"])
        assert "power" in result
        assert "heart_rate" not in result

    def test_power_section_merged(self, sample_parsed_fit):
        """Power section merges availability + stats + summary."""
        result = get_activity_summary_tool(sample_parsed_fit, sections=["power"])
        power = result["power"]
        assert power["available"] is True
        assert "stats" in power
        assert "summary" in power
        assert power["summary"]["avg_power_w"] is not None

    def test_heart_rate_section_merged(self, sample_parsed_fit):
        """Heart rate section merges availability + stats + summary."""
        result = get_activity_summary_tool(sample_parsed_fit, sections=["heart_rate"])
        hr = result["heart_rate"]
        assert hr["available"] is True
        assert "stats" in hr
        assert "summary" in hr

    def test_cadence_section_merged(self, sample_parsed_fit):
        result = get_activity_summary_tool(sample_parsed_fit, sections=["cadence"])
        cad = result["cadence"]
        assert cad["available"] is True
        assert "stats" in cad
        assert "summary" in cad

    def test_speed_section_merged(self, sample_parsed_fit):
        result = get_activity_summary_tool(sample_parsed_fit, sections=["speed"])
        spd = result["speed"]
        assert spd["available"] is True
        assert "stats" in spd
        assert "summary" in spd

    def test_elevation_section_merged(self, sample_parsed_fit):
        result = get_activity_summary_tool(sample_parsed_fit, sections=["elevation"])
        elev = result["elevation"]
        assert elev["available"] is True
        assert "summary" in elev
        assert elev["summary"]["total_ascent_m"] is not None

    def test_power_unavailable(self):
        parsed = {"summary": {"has_power": False}, "records": [], "sessions": [], "training_metadata": {}}
        result = get_activity_summary_tool(parsed, sections=["power"])
        assert result["power"]["available"] is False

    def test_hr_unavailable(self):
        parsed = {"summary": {"has_heart_rate": False}, "records": [], "sessions": [], "training_metadata": {}}
        result = get_activity_summary_tool(parsed, sections=["heart_rate"])
        assert result["heart_rate"]["available"] is False


class TestNormalizeAnalysisSubmission:
    def test_adds_default_brief(self):
        result = normalize_analysis_submission({"summary_label": "恢复骑"})
        assert result == {"summary_label": "恢复骑", "brief": ""}

    def test_preserves_existing_fields(self):
        entry = {"brief": "自定义笔记", "custom_field": "keep_me"}
        result = normalize_analysis_submission(entry)
        assert result["brief"] == "自定义笔记"
        assert result["custom_field"] == "keep_me"


# -- 安全测试:strict bool / 上传错误状态 / sync count 上限 -----------------

class TestBuildInitialLoopPayload:
    def test_llm_payload_only_exposes_local_start_time(self, sample_parsed_fit, tmp_path):
        fit_path = tmp_path / "test_activity.fit"
        fit_path.write_bytes(b"mock fit content")
        payload = build_initial_loop_payload(
            fit_path,
            sample_parsed_fit,
            history_before=None,
            strava_summary_tone={"name": "minimal_brief", "description": "test"},
        )
        fit_summary = payload["fit_summary"]
        assert fit_summary["start_time_local"] == "2026-05-14T16:00:00"
        assert "start_time" not in fit_summary
        assert "start_time_utc" not in fit_summary
        assert "timezone_note" not in fit_summary
        # 工具已迁移到原生 tools 参数,不再出现在 payload 中
        assert "available_tools" not in payload
        assert payload["completion_contract"]["tool"] == "submit_analysis"
        assert payload["activity_metrics"]["schema_version"] == "activity_metrics.v2"
        assert payload["activity_features"]["schema_version"] == "activity_features.v1"

    def test_includes_targeted_user_request(self, sample_parsed_fit, tmp_path):
        fit_path = tmp_path / "test_activity.fit"
        fit_path.write_bytes(b"mock fit content")

        payload = build_initial_loop_payload(
            fit_path,
            sample_parsed_fit,
            history_before=None,
            strava_summary_tone={"name": "minimal_brief", "description": "test"},
            user_request="检查 100-200 秒是否有短冲刺",
        )

        assert payload["user_request"] == "检查 100-200 秒是否有短冲刺"
        assert "answer that question explicitly" in payload["instruction"]


def test_submit_analysis_ends_child_loop(sample_parsed_fit, tmp_path, monkeypatch):
    fit_path = tmp_path / "test_activity.fit"
    fit_path.write_bytes(b"mock fit content")
    captured = {}

    class FakeClient:
        def create_messages(self, **kwargs):
            captured["tools"] = kwargs["tools"]
            return {
                "id": "submit-response",
                "model": "test-model",
                "stop_reason": "tool_use",
                "content": [
                    {
                        "type": "tool_use",
                        "id": "submit-1",
                        "name": "submit_analysis",
                        "input": {
                            "markdown_report": "# 完成报告",
                            "strava_summary": "一次简短骑行总结。",
                            "analysis_summary": {"summary_label": "恢复骑"},
                        },
                    }
                ],
            }

    monkeypatch.setattr("agent.analysis.agent.AnthropicMessagesClient", FakeClient)
    monkeypatch.setattr("agent.analysis.agent.new_session_id", lambda prefix: "submit-test")
    monkeypatch.setattr("agent.analysis.agent.append_chat_log", lambda *args, **kwargs: tmp_path / "submit.jsonl")

    result = analyze_with_llm(fit_path, sample_parsed_fit, history_before=None)

    assert result["markdown_report"] == "# 完成报告"
    assert result["analysis_summary"] == {"summary_label": "恢复骑"}
    tool_names = [tool["name"] for tool in captured["tools"]]
    assert tool_names[-1] == "submit_analysis"
    assert "get_history" not in tool_names
    assert SUBMIT_ANALYSIS_TOOL.input_schema["required"] == ["markdown_report", "strava_summary", "analysis_summary"]


def test_explicit_time_window_exposes_and_requires_raw_interval_evidence(sample_parsed_fit, tmp_path, monkeypatch):
    """A candidate must not be accepted as proof for an explicit time window."""
    fit_path = tmp_path / "test_activity.fit"
    fit_path.write_bytes(b"mock fit content")
    calls = []

    class FakeClient:
        def create_messages(self, **kwargs):
            calls.append(kwargs)
            if len(calls) == 1:
                # The loop must reject this premature completion.
                return {
                    "id": "premature", "model": "test-model", "stop_reason": "tool_use",
                    "content": [{"type": "tool_use", "id": "submit-early", "name": "submit_analysis",
                                 "input": {"markdown_report": "# 猜测", "strava_summary": "摘要", "analysis_summary": {}}}],
                }
            if len(calls) == 2:
                return {
                    "id": "interval", "model": "test-model", "stop_reason": "tool_use",
                    "content": [{"type": "tool_use", "id": "window", "name": "get_time_intervals",
                                 "input": {"bucket_seconds": 10, "start_s": 100, "end_s": 200}}],
                }
            return {
                "id": "submit", "model": "test-model", "stop_reason": "tool_use",
                "content": [{"type": "tool_use", "id": "submit-final", "name": "submit_analysis",
                             "input": {"markdown_report": "# 有局部证据", "strava_summary": "摘要", "analysis_summary": {}}}],
            }

    monkeypatch.setattr("agent.analysis.agent.AnthropicMessagesClient", FakeClient)
    monkeypatch.setattr("agent.analysis.agent.new_session_id", lambda prefix: "window-test")
    monkeypatch.setattr("agent.analysis.agent.append_chat_log", lambda *args, **kwargs: tmp_path / "window.jsonl")

    result = analyze_with_llm(
        fit_path, sample_parsed_fit, history_before=None,
        user_request="100–200 秒有没有连续冲刺？",
    )

    assert result["markdown_report"] == "# 有局部证据"
    assert [tool["name"] for tool in calls[0]["tools"]] == ["get_time_intervals", "submit_analysis"]
    assert "explicit raw window requires get_time_intervals" in str(calls[1]["messages"])


def test_lazy_fit_handlers_parse_only_when_raw_tool_is_called(sample_parsed_fit):
    from agent.tools.fit_analysis.handlers import build_tool_handlers

    calls = []
    handlers = build_tool_handlers(lambda: calls.append("parse") or sample_parsed_fit, None)

    assert calls == []
    handlers["get_time_intervals"](bucket_seconds=60)
    assert calls == ["parse"]


def test_invalid_submit_analysis_is_repaired_inside_child_loop(sample_parsed_fit, tmp_path, monkeypatch):
    fit_path = tmp_path / "test_activity.fit"
    fit_path.write_bytes(b"mock fit content")
    calls = []

    class FakeClient:
        def create_messages(self, **kwargs):
            calls.append(kwargs["messages"])
            if len(calls) == 1:
                return {
                    "id": "invalid-submit",
                    "model": "test-model",
                    "content": [{
                        "type": "tool_use",
                        "id": "submit-invalid",
                        "name": "submit_analysis",
                        "input": {"markdown_report": "", "strava_summary": "摘要", "analysis_summary": {}},
                    }],
                }
            return {
                "id": "valid-submit",
                "model": "test-model",
                "content": [{
                    "type": "tool_use",
                    "id": "submit-valid",
                    "name": "submit_analysis",
                    "input": {
                        "markdown_report": "# 修复后的报告",
                        "strava_summary": "摘要",
                        "analysis_summary": {},
                    },
                }],
            }

    monkeypatch.setattr("agent.analysis.agent.AnthropicMessagesClient", FakeClient)
    monkeypatch.setattr("agent.analysis.agent.new_session_id", lambda prefix: "repair-test")
    monkeypatch.setattr("agent.analysis.agent.append_chat_log", lambda *args, **kwargs: tmp_path / "repair.jsonl")

    result = analyze_with_llm(fit_path, sample_parsed_fit, history_before=None)

    assert result["markdown_report"] == "# 修复后的报告"
    repair_message = next(
        block
        for message in calls[1]
        for block in (message.get("content") if isinstance(message.get("content"), list) else [])
        if isinstance(block, dict) and block.get("is_error") is True
    )
    assert repair_message["is_error"] is True
    assert "non-empty markdown_report" in repair_message["content"]


class TestAnalyzeFitFileResultTimes:
    def test_project_external_fit_is_saved_as_absolute_path(
        self, sample_parsed_fit, tmp_path, monkeypatch
    ):
        project_root = tmp_path / "project"
        project_root.mkdir()
        external_fit = tmp_path / "imports" / "run.fit"
        external_fit.parent.mkdir()
        external_fit.write_bytes(b"mock fit content")
        monkeypatch.chdir(project_root)
        monkeypatch.setattr("agent.analysis.agent.parse_fit", lambda path: sample_parsed_fit)
        monkeypatch.setattr(
            "agent.analysis.agent.analyze_with_llm",
            lambda path, parsed, history_before, user_request, facts=None, fit_summary=None: {
                "model": "test-model",
                "markdown_report": "# Report",
                "strava_summary": "summary",
                "analysis_summary": {},
            },
        )

        result = analyze_fit_file(external_fit, persist=False, force=True)

        assert result["fit_path"] == str(external_fit.resolve())
        assert result["analysis_summary"]["schema_version"] == "activity_analysis_summary.v1"
        assert result["activity_metrics"]["schema_version"] == "activity_metrics.v2"
        assert result["activity_metrics"]["load"]["power_stress"]["tss"] == 45.0

    def test_result_fit_summary_uses_only_local_time(
        self, sample_parsed_fit, tmp_path, monkeypatch
    ):
        fit_path = tmp_path / "test_activity.fit"
        fit_path.write_bytes(b"mock fit content")
        monkeypatch.chdir(tmp_path)
        monkeypatch.setattr("agent.analysis.agent.parse_fit", lambda path: sample_parsed_fit)
        monkeypatch.setattr(
            "storage.repositories.activity.ActivityStore.query_history",
            lambda self, **kwargs: {
                "schema_version": "activity_report_history.v1",
                "count": 1,
                "activities": [
                    {
                        "start_time": "2026-05-13T00:00:00+00:00",
                        "start_time_local": "2026-05-13T08:00:00+08:00",
                    }
                ],
            },
        )
        monkeypatch.setattr(
            "agent.analysis.agent.analyze_with_llm",
            lambda path, parsed, history_before, user_request, facts=None, fit_summary=None: {
                "model": "test-model",
                "markdown_report": "# Report",
                "strava_summary": "summary",
                "analysis_summary": {},
            },
        )

        result = analyze_fit_file(fit_path, use_history=True, force=True)

        assert result["fit_summary"]["start_time_local"] == "2026-05-14T16:00:00"
        assert "start_time" not in result["fit_summary"]
        assert "start_time_utc" not in result["fit_summary"]
        assert "timezone_note" not in result["fit_summary"]
        history_activity = result["history_context"]["activities"][0]
        assert history_activity["start_time_local"] == "2026-05-13T08:00:00"
        assert "start_time" not in history_activity


class TestSyncCountLimit:
    def test_max_sync_count_is_declared(self):
        # 只测同步上限常量,不实际调用 Garmin(会因无凭证报错)
        from operations.activity.service import MAX_SYNC_COUNT
        assert MAX_SYNC_COUNT == 20

    def test_count_above_limit_is_rejected(self):
        import pytest

        from operations.activity.service import sync_garmin_activities_tool

        with pytest.raises(ValueError, match="between 1 and 20"):
            sync_garmin_activities_tool(count=50)


class _LegacyUploadErrorStates:
    def test_no_summary(self):
        from agent.operations import upload_to_strava_tool
        result = upload_to_strava_tool("/tmp/nonexistent_activity.fit")
        assert result["error"] == "no_summary"

    def test_upload_proceeds(self, tmp_path, monkeypatch):
        """调用上传工具即执行上传。"""
        import json
        from unittest.mock import MagicMock
        from agent.operations import upload_to_strava_tool

        fit_file = tmp_path / "test.fit"
        fit_file.write_bytes(b"mock")
        summary_dir = tmp_path / "data" / "summaries"
        summary_dir.mkdir(parents=True)
        summary = {
            "fit_path": "test.fit",
            "strava_summary": "测试总结",
            "fit_summary": {"sport_type": "cycling", "start_time_local": "2026-05-15T08:00:00+08:00"},
            "activity_key": "abc123",
        }
        (summary_dir / "test.summary.json").write_text(
            json.dumps(summary, ensure_ascii=False), encoding="utf-8"
        )

        monkeypatch.chdir(tmp_path)

        mock_sink = MagicMock()
        mock_sink.upload_fit.return_value = {"id": 99999}
        mock_sink.wait_for_upload.return_value = {"activity_id": 88888}
        mock_sink_cls = MagicMock(return_value=mock_sink)
        monkeypatch.setattr("integrations.strava.StravaSink", mock_sink_cls)

        result = upload_to_strava_tool(str(fit_file))
        assert result["status"] == "uploaded"
        assert result["strava_activity_id"] == 88888
        assert result["pending_activity"]["fit_path"] == str(fit_file)

    def test_duplicate_returns_existing_and_pending_activity(self, tmp_path, monkeypatch):
        import json
        from agent.operations import upload_to_strava_tool

        fit_file = tmp_path / "test.fit"
        fit_file.write_bytes(b"mock")
        summary_dir = tmp_path / "data" / "summaries"
        summary_dir.mkdir(parents=True)
        summary = {
            "fit_path": str(fit_file),
            "strava_summary": "测试总结",
            "fit_summary": {"sport_type": "cycling", "start_time_local": "2026-05-15T08:00:00"},
            "activity_key": "abc123",
        }
        (summary_dir / "test.summary.json").write_text(
            json.dumps(summary, ensure_ascii=False), encoding="utf-8"
        )
        monkeypatch.chdir(tmp_path)

        def fake_upload_summary_to_strava(summary_path: str, *, wait: bool = True, force: bool = False):
            assert force is False
            return {
                "status": "duplicate",
                "strava_activity_id": "18619000064",
                "message": "该活动已上传到 Strava。",
            }

        monkeypatch.setattr("integrations.strava.upload_summary_to_strava", fake_upload_summary_to_strava)

        result = upload_to_strava_tool(str(fit_file))

        assert result["status"] == "duplicate"
        assert result["existing_activity"]["strava_activity_id"] == "18619000064"
        assert result["existing_activity"]["url"] == "https://www.strava.com/activities/18619000064"
        assert result["pending_activity"]["activity_key"] == "abc123"
        assert result["pending_activity"]["title"] == "2026-05-15 cycling"

    def test_force_duplicate_updates_existing_description(self, tmp_path, monkeypatch):
        import json
        from agent.operations import upload_to_strava_tool

        fit_file = tmp_path / "test.fit"
        fit_file.write_bytes(b"mock")
        summary_dir = tmp_path / "data" / "summaries"
        summary_dir.mkdir(parents=True)
        summary = {
            "fit_path": str(fit_file),
            "strava_summary": "测试总结",
            "fit_summary": {"sport_type": "cycling", "start_time_local": "2026-05-15T08:00:00"},
            "activity_key": "abc123",
        }
        (summary_dir / "test.summary.json").write_text(
            json.dumps(summary, ensure_ascii=False), encoding="utf-8"
        )
        monkeypatch.chdir(tmp_path)

        def fake_upload_summary_to_strava(summary_path: str, *, wait: bool = True, force: bool = False):
            assert force is True
            return {"status": "description_updated", "strava_activity_id": "18619000064"}

        monkeypatch.setattr("integrations.strava.upload_summary_to_strava", fake_upload_summary_to_strava)

        result = upload_to_strava_tool(str(fit_file), force=True)

        assert result["status"] == "description_updated"
        assert result["existing_activity"]["strava_activity_id"] == "18619000064"
        assert result["pending_activity"]["activity_key"] == "abc123"

    def test_network_error_is_structured(self, tmp_path, monkeypatch):
        import json
        import requests
        from agent.operations import upload_to_strava_tool

        fit_file = tmp_path / "test.fit"
        fit_file.write_bytes(b"mock")
        summary_dir = tmp_path / "data" / "summaries"
        summary_dir.mkdir(parents=True)
        summary = {
            "fit_path": str(fit_file),
            "strava_summary": "测试总结",
            "fit_summary": {"sport_type": "cycling", "start_time_local": "2026-05-15T08:00:00"},
            "activity_key": "abc123",
        }
        (summary_dir / "test.summary.json").write_text(
            json.dumps(summary, ensure_ascii=False), encoding="utf-8"
        )
        monkeypatch.chdir(tmp_path)

        def fake_upload_summary_to_strava(summary_path: str, *, wait: bool = True, force: bool = False):
            raise requests.exceptions.ConnectTimeout("timeout")

        monkeypatch.setattr("integrations.strava.upload_summary_to_strava", fake_upload_summary_to_strava)

        result = upload_to_strava_tool(str(fit_file))

        assert result["error"] == "network_error"
        assert "timeout" in result["message"]
        assert result["pending_activity"]["activity_key"] == "abc123"
