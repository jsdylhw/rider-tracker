import io
import json
import pytest
from integrations.route_providers import amap_throttle as throttle
from integrations.provider_error import ProviderError, TransientProviderError
from integrations.route_providers.budget import route_request_budget, RouteBudgetExceeded
from services.route import single_day


@pytest.fixture
def clock(monkeypatch):
    now = [0.0]
    waits = []
    monkeypatch.setattr(throttle, '_next', {})
    monkeypatch.setattr(throttle, 'monotonic', lambda: now[0])
    def sleep(seconds):
        waits.append(seconds)
        now[0] += seconds
    monkeypatch.setattr(throttle, 'sleep', sleep)
    return waits


def test_shared_endpoint_slots_ignore_keys_but_separate_services(clock):
    throttle.pace('https://restapi.amap.com/v5/place/text?key=a')
    throttle.pace('https://restapi.amap.com/v5/place/text?key=b')
    throttle.pace('https://restapi.amap.com/v5/direction/bicycling?key=a')
    assert clock == [1.05]


def transport(monkeypatch, responses):
    calls=[]
    class Response(io.BytesIO):
        pass
    class Opener:
        def open(self,url,timeout):
            calls.append(url)
            return Response(json.dumps(responses[min(len(calls)-1,len(responses)-1)]).encode())
    monkeypatch.setattr(single_day,'build_opener',lambda *args:Opener())
    return calls


@pytest.mark.parametrize('recover', [True,False])
def test_places_200_qps_retry_is_bounded_and_observable(monkeypatch,clock,recover):
    qps={'status':'0','infocode':'10021','info':'CUQPS_HAS_EXCEEDED_THE_LIMIT'}
    calls=transport(monkeypatch,[qps,{'status':'1','pois':[{'name':'景点'}]}] if recover else [qps])
    events=[]
    with throttle.map_retry_progress(events.append):
        if recover:
            assert single_day._read_json_url('https://restapi.amap.com/v5/place/text',provider='AMap Places')['pois']
        else:
            with pytest.raises(TransientProviderError):
                single_day._read_json_url('https://restapi.amap.com/v5/place/text',provider='AMap Places')
    assert len(calls)==(2 if recover else 3)
    assert len([e for e in events if e['status']=='running'])==(1 if recover else 2)
    assert events[0]['label']=='地图服务繁忙，正在等待重试'
    assert throttle._callback.get() is None


def test_invalid_key_not_retried(monkeypatch,clock):
    calls=transport(monkeypatch,[{'status':'0','info':'INVALID_USER_KEY','infocode':'10001'}])
    with pytest.raises(ProviderError):
        single_day._read_json_url('https://restapi.amap.com/v5/place/text',provider='AMap Places')
    assert len(calls)==1
    assert clock==[]


def test_retry_respects_time_budget_and_observer_failure(clock):
    with route_request_budget(timeout_s=.1):
        with pytest.raises(RouteBudgetExceeded):
            throttle.retry_wait(0)
    assert clock==[]
    def broken(event): raise RuntimeError('disconnected')
    with throttle.map_retry_progress(broken): throttle.retry_wait(0)
    assert clock==[1.0]


@pytest.mark.parametrize('status,attempts', [(429,3),(503,3),(403,1)])
def test_http_failures_have_one_bounded_retry_loop(monkeypatch,clock,status,attempts):
    from urllib.error import HTTPError
    calls=[]
    class Opener:
        def open(self,url,timeout):
            calls.append(url)
            raise HTTPError(url,status,'provider failure',{},None)
    monkeypatch.setattr(single_day,'build_opener',lambda *args:Opener())
    with pytest.raises(ProviderError):
        single_day._read_json_url('https://restapi.amap.com/v5/place/text',provider='AMap Places')
    assert len(calls)==attempts
