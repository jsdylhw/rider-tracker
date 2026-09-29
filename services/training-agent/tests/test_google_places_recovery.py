from unittest.mock import Mock
import pytest
from integrations import google_places as places
from integrations.provider_error import ProviderError, TransientProviderError


def test_transient_retry_backoff_progress_and_success_cache(monkeypatch):
    monkeypatch.setattr(places.random, 'uniform', lambda *a: 1)
    sleep = Mock()
    monkeypatch.setattr(places.time, 'sleep', sleep)
    transport = Mock(side_effect=[TransientProviderError('reset'), TransientProviderError('reset'), {'places': []}])
    events = []
    with places.places_request_scope(events.append):
        client = places.GooglePlacesClient('key', transport=transport)
        client.search('Roma')
        client.search('Roma')
        assert transport.call_count == 3
    assert [c.args[0] for c in sleep.call_args_list] == [.4, .8]
    assert [e['status'] for e in events] == ['running', 'completed'] * 2
    assert all(e['stage'] == 'map_retry' for e in events)


def test_cache_is_scoped_and_parameter_sensitive():
    transport = Mock(return_value={'places': []})
    with places.places_request_scope():
        a = places.GooglePlacesClient('key', transport=transport)
        a.search('Roma')
        a.search('Roma', language_code='it')
        places.GooglePlacesClient('other-key', transport=transport).search('Roma')
        a.search('Roma')
        assert transport.call_count == 3
    with places.places_request_scope():
        a.search('Roma')
    assert transport.call_count == 4


def test_nontransient_errors_are_not_retried_or_cached():
    transport = Mock(side_effect=ProviderError('bad key'))
    with places.places_request_scope():
        client = places.GooglePlacesClient('key', transport=transport)
        for _ in range(2):
            with pytest.raises(ProviderError): client.search('Roma')
    assert transport.call_count == 2


def test_shared_retry_budget_limits_multiple_failed_points(monkeypatch):
    monkeypatch.setattr(places.time, 'sleep', lambda _: None)
    transport = Mock(side_effect=TransientProviderError('reset'))
    with places.places_request_scope():
        client = places.GooglePlacesClient('key', transport=transport)
        for i in range(4):
            with pytest.raises(TransientProviderError): client.search(str(i))
    assert transport.call_count == 4 + 12


def test_time_budget_preserves_original_failure(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(places.time, 'monotonic', lambda: clock[0])
    def send(req, timeout):
        assert timeout <= 2
        clock[0] += 2
        raise TransientProviderError('original reset')
    transport = Mock(side_effect=send)
    with pytest.raises(TransientProviderError, match='original reset'):
        places.GooglePlacesClient('key', retry_budget_s=2, transport=transport).search('Roma')
    assert transport.call_count == 1
