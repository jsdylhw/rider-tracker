from unittest.mock import Mock
import pytest
from agent.route.agent import run_route_agent
from agent.route.contracts import RouteTaskInput
from agent.route import agent
from services.route.research import search_cycling_routes
from integrations.provider_error import ProviderError


def test_search_bounds_dedup_and_partial_failure():
    client = Mock()
    client.search.side_effect = [[{'title': 'route', 'url': 'https://example.org/route', 'raw_content': 'a'*9000},
                                 {'url': 'javascript:alert(1)'}, {'url': 'https://example.org/route'}],
                                ProviderError('offline')]
    result = search_cycling_routes(['京都', 'Kyoto'], client=client)
    assert len(result['sources']) == 1
    assert len(result['sources'][0]['content']) == 4500
    assert result['failures'] and result['status'] == 'ok'


def test_search_result_is_read_before_next_tool(monkeypatch):
    calls = []
    def search(args, context):
        return {'status': 'ok', 'sources': [{'title': '真实来源测试'}]}
    monkeypatch.setitem(agent.TOOL_HANDLERS, 'search_cycling_routes', search)
    create = Mock()
    monkeypatch.setitem(agent.TOOL_HANDLERS, 'create_route_plan', create)
    class Client:
        def create_messages(self, **kwargs):
            calls.append(kwargs)
            if len(calls) == 1:
                blocks = [('search_cycling_routes', {'queries': ['京都']}), ('create_route_plan', {})]
            else:
                assert '真实来源测试' in str(kwargs['messages'])
                blocks = [('request_route_clarification', {'question': '是否沿河？'})]
            return {'stop_reason': 'tool_use', 'content': [
                {'type': 'tool_use', 'id': str(i), 'name': name, 'input': args}
                for i, (name, args) in enumerate(blocks)]}
    result, _ = run_route_agent(RouteTaskInput(message='京都30km', workspace_id='test', request_id='test'), client=Client())
    assert len(calls) == 2
    create.assert_not_called()
    assert result['status'] == 'clarification_required'


def test_search_budget_even_on_failure(monkeypatch):
    search = Mock(return_value={'status': 'failed', 'error': 'offline'})
    monkeypatch.setitem(agent.TOOL_HANDLERS, 'search_cycling_routes', search)
    class Client:
        def create_messages(self, **kwargs):
            return {'stop_reason': 'tool_use', 'content': [
                {'type': 'tool_use', 'id': 's', 'name': 'search_cycling_routes', 'input': {'queries': ['京都']}}]}
    result, _ = run_route_agent(RouteTaskInput(message='京都30km', workspace_id='test', request_id='test'), client=Client())
    assert search.call_count == 2
    assert result['route_task']['status'] == 'failed'
    assert not result.get('route_plan')


def test_references_are_server_owned_and_projected():
    from agent.main_agent.context import AgentContext
    from agent.tools.handlers.route import _with_research
    from services.route.view import build_route_plan_view
    context = AgentContext(session_id='research')
    context.route_research = [{'source_id': 'web_one', 'title': '骑行资料',
                              'url': 'https://example.org/route', 'content': 'not persisted'}]
    plan = _with_research({'plan_id': 'p', 'revision': 1}, context)
    sources = build_route_plan_view(plan)['research_sources']
    assert sources[0]['url'] == 'https://example.org/route'
    assert 'content' not in sources[0]
    assert _with_research(plan, AgentContext(session_id='next')) == plan


def test_tavily_transport_hides_key_and_handles_http_failure(monkeypatch):
    from integrations import web_search
    from urllib.error import HTTPError
    import pytest
    monkeypatch.setattr(web_search, 'load_config', lambda: {'Tavily': {'api_key': 'test-secret'}})
    def fail(request, timeout):
        assert request.get_header('Authorization') == 'Bearer test-secret'
        raise HTTPError(request.full_url, 401, 'test-secret', {}, None)
    monkeypatch.setattr(web_search, 'urlopen', fail)
    with pytest.raises(ProviderError) as raised:
        web_search.TavilySearchClient().search('京都')
    assert str(raised.value) == 'Tavily HTTP 401'
    assert not raised.value.retryable


def test_queries_share_result_budget_and_keep_search_excerpt():
    client = Mock()
    client.search.side_effect = [
        [{'url': f'https://first.example/{i}', 'content': '入口摘要', 'raw_content': 'page'} for i in range(5)],
        [{'url': f'https://second.example/{i}', 'content': '路线摘要'} for i in range(5)],
    ]
    result = search_cycling_routes(['地点入口', '已有路线'], client=client)
    assert [r['query'] for r in result['sources']] == ['地点入口', '已有路线', '地点入口', '已有路线', '地点入口']
    assert result['sources'][0]['excerpt'] == '入口摘要'


def test_duplicate_and_malformed_urls_do_not_starve_second_query():
    client = Mock()
    client.search.side_effect = [[{'url': 'https://example.org/shared'}, {'url': 'https://[invalid'}],
                                [{'url': 'https://example.org/shared'}, {'url': 'https://example.org/second'}]]
    result = search_cycling_routes(['a', 'b'], client=client)
    assert [r['url'] for r in result['sources']] == ['https://example.org/shared', 'https://example.org/second']


@pytest.mark.parametrize("fails", [False, True])
def test_deferred_create_can_succeed_with_revised_arguments(monkeypatch, tmp_path, fails):
    from agent.main_agent import result_builder
    monkeypatch.setenv('RIDER_LOG_DIR', str(tmp_path))
    plan = {'plan_id': 'plan', 'workspace_id': 'test', 'revision': 1}
    monkeypatch.setattr(result_builder, 'RoutePlanStore', lambda: Mock(get=lambda _: plan))
    monkeypatch.setattr(result_builder, 'build_route_plan_view', lambda value: value)
    monkeypatch.setitem(agent.TOOL_HANDLERS, 'search_cycling_routes', lambda a, c: {'status': 'ok'})
    create = Mock(return_value=({'status': 'failed', 'code': 'provider_connection_failed', 'error': 'offline', 'message': '地图不可用'} if fails else {'status': 'completed', 'answer': '已创建', 'result': {'plan_id': 'plan'}}))
    monkeypatch.setitem(agent.TOOL_HANDLERS, 'create_route_plan', create)
    class Client:
        rounds = 0
        def create_messages(self, **kwargs):
            self.rounds += 1
            calls = [('search_cycling_routes', {}), ('create_route_plan', {'title': '初步方案'})] if self.rounds == 1 else [('create_route_plan', {'title': '阅读资料后的方案'})]
            return {'stop_reason': 'tool_use', 'content': [
                {'type': 'tool_use', 'id': str(i), 'name': name, 'input': args}
                for i, (name, args) in enumerate(calls)]}
    progress = []
    result, _ = run_route_agent(RouteTaskInput(message='京都30km', workspace_id='test', request_id='test'), client=Client(), on_progress=progress.append)
    if fails:
        assert result['error']['code'] == 'provider_connection_failed'
        assert not result.get('route_plan')
    else:
        assert result['status'] == 'completed'
        assert result['route_plan']['plan_id'] == 'plan'
    assert create.call_count == 1
    assert not any(record['status'] == 'blocked' for record in result['executions'])
    assert [p['status'] for p in progress if p['stage'] == 'create_route_plan'] == ['running', 'failed' if fails else 'completed']
