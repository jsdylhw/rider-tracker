from __future__ import annotations

import json
import pytest
from agent.analysis.query import run_activity_query_agent
from fit.analysis.data import get_time_intervals_tool


@pytest.mark.parametrize('question', ['前五分钟，每10秒看功率', '0–5分钟，每10秒看功率'])
def test_window_queries_use_same_model_tool_path(question, sample_parsed_fit, tmp_path, monkeypatch):
    fit_path = tmp_path / 'focused.fit'
    fit_path.write_bytes(b'mock')
    outputs = []

    class FakeClient:
        def create_messages(self, **kwargs):
            if not outputs:
                assert 'get_time_intervals' in [t['name'] for t in kwargs['tools']]
                outputs.append(None)
                return {'content': [{'type': 'tool_use', 'id': 'window', 'name': 'get_time_intervals',
                                     'input': {'start_s': 0, 'end_s': 300, 'bucket_seconds': 10}}]}
            evidence = json.loads(kwargs['messages'][-1]['content'][0]['content'])
            assert evidence['bucket_seconds'] == 10
            assert evidence['window'] == {'start_s': 0.0, 'end_s': 300.0}
            assert 'samples' in evidence['columns']
            assert evidence['format'] == 'table'
            assert 'window_summary' in evidence
            outputs.append(evidence)
            return {'content': [{'type': 'tool_use', 'id': 'done', 'name': 'submit_query_answer',
                                 'input': {'answer': '前五分钟结果', 'evidence': [], 'limitations': []}}]}

    monkeypatch.setattr('agent.analysis.query.AnthropicMessagesClient', FakeClient)
    monkeypatch.setattr('agent.analysis.query.parse_fit', lambda _: sample_parsed_fit)
    monkeypatch.setattr('agent.analysis.query.append_chat_log', lambda *a, **k: None)
    result = run_activity_query_agent(fit_path, question=question)
    assert result['status'] == 'answered_query'
    assert len(outputs) == 2


def test_window_summary_is_bucket_independent_and_missing_columns_survive():
    parsed = {'records': [
        {'elapsed_s': 0, 'power': 0, 'heart_rate': 100},
        {'elapsed_s': 4, 'power': 100, 'heart_rate': 120},
        {'elapsed_s': 10, 'power': None, 'heart_rate': 140},
        {'elapsed_s': 15, 'power': 200, 'heart_rate': None},
    ]}
    five = get_time_intervals_tool(parsed, start_s=0, end_s=15, bucket_seconds=5)
    ten = get_time_intervals_tool(parsed, start_s=0, end_s=15, bucket_seconds=10)
    assert five['window_summary'] == ten['window_summary']
    power = five['window_summary']['metrics']['power']
    assert power == {'mean': 100.0, 'valid_samples': 3, 'missing_samples': 1, 'zero_samples': 1, 'unit': 'W'}
    assert five['series']['avg_power_w'] == [50.0, None, 200.0]
    assert five['series']['power_w_valid_samples'] == [2, 0, 1]
    assert five['series']['power_w_missing_samples'] == [0, 1, 0]
    assert five['series']['end_s'] == [4.0, 10.0, 15.0]
    assert five['window_summary']['metrics']['heart_rate']['mean'] == 120.0


def test_partial_bucket_labels_do_not_exceed_query_and_empty_window():
    parsed = {'records': [{'elapsed_s': i, 'power': 100} for i in range(31)]}
    result = get_time_intervals_tool(parsed, start_s=7, end_s=27, bucket_seconds=10)
    assert result['series']['start_s'] == [7, 10, 20]
    assert result['series']['end_s'] == [9, 19, 27]
    assert result['filtered_count'] == 21
    assert get_time_intervals_tool(parsed, start_s=50, end_s=60)['available'] is False


@pytest.mark.parametrize('tool,bounds', [
    ('get_time_intervals', {'start_s': 0, 'end_s': 15, 'bucket_seconds': 5}),
    ('get_distance_intervals', {'start_d': 0, 'end_d': 150, 'bucket_distance_m': 100}),
])
def test_model_projection_selects_metrics_and_preserves_counts_and_null(tool, bounds):
    from agent.tools.fit_analysis.handlers import build_tool_handlers
    parsed = {'records': [
        {'elapsed_s': 0, 'distance': 0, 'power': 0, 'heart_rate': 100},
        {'elapsed_s': 10, 'distance': 100, 'power': None, 'heart_rate': 120},
    ]}
    handler = build_tool_handlers(parsed, None)[tool]
    summary = handler(**bounds, view='summary', metrics=['power'])
    assert set(summary['window_summary']['metrics']) == {'power'}
    assert not any(key in summary for key in ['rows', 'columns', 'series'])
    table = handler(**bounds, view='intervals', metrics=['power'])
    assert table['window_summary'] == summary['window_summary']
    assert 'avg_hr_bpm' not in table['columns']
    assert 'power_w_missing_samples' in table['columns']
    assert 'power_w_zero_samples' in table['columns']
    index = table['columns'].index('avg_power_w')
    assert [row[index] for row in table['rows']] == [0.0, None]
    with pytest.raises(ValueError):
        handler(**bounds, metrics=['unknown'])


@pytest.mark.parametrize('content', [
    [{'type': 'text', 'text': '部分答案'}],
    [{'type': 'tool_use', 'id': 'done', 'name': 'submit_query_answer', 'input': {'answer': '看似完整'}}],
])
def test_truncated_response_cannot_be_accepted_as_success(monkeypatch, content):
    from agent.analysis.query import _run_query_loop

    class FakeClient:
        def create_messages(self, **kwargs):
            assert kwargs['max_tokens'] == 8192
            return {'stop_reason': 'max_tokens', 'content': content}

    monkeypatch.setattr('agent.analysis.query.AnthropicMessagesClient', FakeClient)
    with pytest.raises(RuntimeError, match='截断'):
        _run_query_loop({}, handlers={})
