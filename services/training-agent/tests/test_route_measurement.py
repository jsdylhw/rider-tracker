from unittest.mock import Mock

import pytest

from integrations.provider_error import TransientProviderError
from integrations.route_providers.budget import (
    RouteBudgetExceeded, consume_route_request, route_request_budget,
)
from integrations.route_providers.google_routes import GoogleRoutesClient, WgsPoint
from services.route import single_day


@pytest.mark.parametrize("distance_m", [30000, 60000])
def test_measurement_retains_rejected_geometry_without_elevation(monkeypatch, distance_m):
    geometry = {'type': 'LineString', 'coordinates': [[135, 35], [135.01, 35], [135, 35]]}
    monkeypatch.setattr(single_day, '_route_google', lambda *a, **k: ([{'query': 'A'}, {'query': 'B'}], {
        'distance_m': distance_m, 'geometry': geometry, 'duration_s': 3600,
        'legs': [{'distance_m': 60000}],
    }))
    elevation = Mock(side_effect=AssertionError('measurement must not request elevation'))
    monkeypatch.setattr(single_day, '_elevation_profile', elevation)
    args = dict(index=1, country_code='JP', include_elevation=False, config={},
                provider_preflight_completed=True,
                route_constraints={'avoid_repeated_roads': True, 'maximum_self_overlap_ratio': 0})
    candidate = {'waypoints': ['A', 'B', 'A'], 'target_distance_km': 30}
    measured = single_day.route_candidate(candidate, measurement_only=True, **{**args, 'include_elevation': True})
    assert measured['distance_m'] == distance_m
    assert measured['geometry'] == geometry
    assert measured['target_distance_km'] == 30
    assert measured['legs'] == [{'distance_m': 60000}]
    assert measured['route_quality']['self_overlap_ratio'] > 0
    assert measured['elevation'] is None
    with pytest.raises(single_day.RouteCandidateRejected):
        single_day.validate_measured_candidate(measured, args['route_constraints'])
    with pytest.raises(single_day.RouteCandidateRejected):
        single_day.route_candidate(candidate, **args)
    elevation.assert_not_called()


def test_finalize_uses_existing_measurement_and_keeps_input(monkeypatch):
    monkeypatch.setattr(single_day, '_elevation_profile', lambda *a: {'profile': 'ok'})
    measured = {'distance_m': 30000, 'target_distance_km': 30,
                'geometry': {'type': 'LineString', 'coordinates': [[135, 35], [135.1, 35]]},
                'elevation': None, 'warnings': []}
    result = single_day.validate_measured_candidate(measured, include_elevation=True, config={})
    assert result['elevation'] == {'profile': 'ok'}
    assert measured['elevation'] is None


def test_budget_counts_google_retries_and_restores_context():
    calls = []
    def failing(request, timeout):
        calls.append(timeout)
        raise TransientProviderError('temporary')
    client = GoogleRoutesClient('test', transport=failing, retry_delay_s=0)
    with route_request_budget(max_requests=2, timeout_s=10) as budget:
        with pytest.raises(RouteBudgetExceeded):
            client.route([WgsPoint(35, 135), WgsPoint(35.1, 135.1)], country_code='JP')
        assert budget.count == len(calls) == 2
        assert all(0 < timeout <= 10 for timeout in calls)
    assert consume_route_request(30) == 30


def test_expired_budget_prevents_http(monkeypatch):
    transport = Mock()
    with route_request_budget(max_requests=2) as budget:
        budget.deadline = 0
        with pytest.raises(RouteBudgetExceeded):
            GoogleRoutesClient('test', transport=transport).route(
                [WgsPoint(35, 135), WgsPoint(35.1, 135.1)], country_code='JP')
        assert budget.count == 0
    transport.assert_not_called()


def test_google_measurement_includes_legs():
    def transport(request, timeout):
        return {'routes': [{'distanceMeters': 1000, 'duration': '30s',
                            'polyline': {'geoJsonLinestring': {
                                'type': 'LineString', 'coordinates': [[135, 35], [135.01, 35]]}},
                            'legs': [{'distanceMeters': 1000, 'startLocation': {'latLng': {'latitude': 35}}}]}]}
    result = GoogleRoutesClient('test', transport=transport).route(
        [WgsPoint(35, 135), WgsPoint(35, 135.01)], country_code='JP')
    assert result['legs'][0]['distance_m'] == 1000
    assert result['legs'][0]['start_location']['latLng']['latitude'] == 35


def test_amap_http_is_counted_and_exhaustion_is_not_retried(monkeypatch):
    from integrations.route_providers import amap
    calls = []
    class Response:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def read(self):
            return '{"status":"1","infocode":"10000","route":{"paths":[{"distance":"1000","steps":[{"polyline":"135,35;135.01,35"}]}]}}'
    class Opener:
        def open(self, request, timeout):
            calls.append(timeout)
            return Response()
    monkeypatch.setattr(amap, 'build_opener', lambda *args: Opener())
    with route_request_budget(max_requests=1) as budget:
        with pytest.raises(RouteBudgetExceeded):
            amap.AmapCyclingRouter('test').route_points([
                amap.AmapPoint(35, 135), amap.AmapPoint(35, 135.01), amap.AmapPoint(35, 135.02)])
        assert len(calls) == budget.count == 1
