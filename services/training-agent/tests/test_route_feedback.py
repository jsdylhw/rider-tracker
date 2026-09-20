from copy import deepcopy
import pytest
from services.route.feedback import plan_with_feedback
from services.route.single_day import RouteCandidateRejected


def fixture():
    points = {i: {'query': i, 'coordinate': [j*.01, 35],
                  'place': {'query': i, 'longitude': j*.01, 'latitude': 35}} for j, i in enumerate('sabcdef')}
    def skeleton(i, distance):
        return {'point_ids': ['s', i, 's'], 'estimated_distance_m': distance, 'legs': [{'kind': 'connector'}],
                'preferred_score': 1, 'control_corridor_coverage': {'river': .5}}
    material = {'origin_id': 's', 'country_code': 'JP', 'target_distance_km': 30, 'is_loop': True,
                'points': [], 'corridors': []}
    initial = [skeleton(i, 30000) for i in 'abc']
    corrected = [skeleton(i, 24000) for i in 'def']
    return {'materials': material, 'points': points, 'skeletons': initial}, corrected


def test_feedback_uses_measured_ratio_preserves_rejected_evidence_and_bounds_calls():
    prep, corrected = fixture()
    seen, aims = [], []
    def measure(spec, **kwargs):
        assert kwargs['measurement_only'] and not kwargs['include_elevation']
        seen.append(spec)
        n = len(seen)
        return {'distance_m': 37500 if n <= 3 else 30000, 'travel_mode': 'DRIVE',
                'geometry': {'type': 'LineString', 'coordinates': [[135,35], [135+.1*n,35+.01*n], [135,35]]},
                'warnings': [], 'target_distance_km': 30}
    def search(*args, **kwargs):
        aims.append(kwargs['estimated_target_m'])
        return corrected
    plan = plan_with_feedback(prep, workspace_id='t', title='t', include_elevation=False, config={},
                              evaluator=measure, validator=lambda value,*a,**kw:deepcopy(value), pool_builder=search)
    assert len(seen) == 6
    assert aims == [24000]
    assert plan['route_search']['evaluation_count'] == 6
    assert len(plan['candidates']) == 3
    first = plan['route_search']['measurements'][0]
    assert first['status'] == 'distance_rejected' and first['geometry']
    assert first['actual_distance_m'] == 37500
    assert plan['route_search']['request_count'] == 0  # No real HTTP in this test.


def test_failed_distance_feedback_never_publishes_out_of_range_candidate():
    prep, corrected = fixture()
    def measure(*a, **kw):
        return {'distance_m': 45000, 'travel_mode': 'DRIVE', 'geometry': {'coordinates': [[0,0],[1,1]]}}
    with pytest.raises(RouteCandidateRejected, match='预算内') as raised:
        plan_with_feedback(prep, workspace_id='t', title='t', include_elevation=False, config={},
                           evaluator=measure, pool_builder=lambda *a,**kw: corrected)
    assert raised.value.search_diagnostics['evaluation_count'] == 6
    public = raised.value.to_tool_result()['route_search']
    assert public['evaluation_count'] == 6
    assert all('geometry' not in row for row in public['measurements'])


def test_exact_duplicates_do_not_consume_second_round_measurements():
    prep, _ = fixture()
    seen = []
    def measure(spec, **kw):
        seen.append(spec)
        return {'distance_m': 30000, 'geometry': {'coordinates': [[135,35],[135.1,35.1],[135,35]]}, 'warnings': []}
    result = plan_with_feedback(prep, workspace_id='t', title='t', include_elevation=False, config={},
                               evaluator=measure, validator=lambda v,*a,**kw:deepcopy(v),
                               pool_builder=lambda *a,**kw: prep['skeletons'])
    assert len(seen) == 3 and len(result['candidates']) == 1
    assert '仅找到 1 条' in result['candidates'][0]['warnings'][0]


def test_unrestricted_distance_does_not_drown_out_scenery_preference():
    prep, _ = fixture()
    prep['materials'].pop('target_distance_km')
    prep['materials']['distance_mode'] = 'unrestricted'
    prep['skeletons'][0].update(estimated_distance_m=1000, preferred_score=0)
    prep['skeletons'][1].update(estimated_distance_m=30000, preferred_score=10)
    seen = []
    def measure(spec, **kw):
        seen.append(spec['waypoints'][1])
        return {'distance_m': 35000, 'geometry': {'coordinates': [[135,35],[135.1,35.1],[135,35]]}, 'warnings': []}
    result = plan_with_feedback(prep, workspace_id='t', title='t', include_elevation=False, config={},
                               evaluator=measure, validator=lambda v,*a,**kw: deepcopy(v),
                               pool_builder=lambda *a,**kw: prep['skeletons'])
    assert seen[0] == 'b'
    assert result['route_search']['measurements'][0]['distance_error_ratio'] == 0


def test_mountain_candidates_compare_google_ascent_before_selection(monkeypatch):
    from services.route import single_day
    from services.route.ascent import enrich_ascent_preview
    prep, _ = fixture()
    prep['materials'].update(target_distance_km=40, scenery_preferences=['mountain'])
    calls = []
    def elevation(coords, distance, config):
        calls.append(distance)
        return {'summary': {'ascent_m': {40000: 50, 42000: 840, 47000: 940}[distance]}}
    monkeypatch.setattr(single_day, '_elevation_profile', elevation)
    def measure(spec, **kwargs):
        n = 'abc'.index(spec['waypoints'][1])
        return {'distance_m': [40000, 42000, 47000][n],
                'geometry': {'coordinates': [[135,35],[135+.1*(n+1),35+.02*n],[135,35]]}}
    result = plan_with_feedback(prep, workspace_id='t', title='t', include_elevation=False,
        include_ascent=True, config={}, evaluator=measure, validator=lambda v,*a,**kw:deepcopy(v),
        pool_builder=lambda *a,**kw:prep['skeletons'])
    assert result['candidates'][0]['distance_m'] == 42000
    assert {c['distance_m'] for c in result['candidates']} == {40000,42000,47000}
    assert len(calls) == 3
    assert result['route_search']['ascent_evaluation_count'] == 3
    enrich_ascent_preview(result, config={})
    assert len(calls) == 3
    assert all('elevation' not in c for c in result['candidates'])


def test_ascent_failure_keeps_road_and_does_not_retry_in_final_preview(monkeypatch):
    from services.route import single_day
    from services.route.ascent import enrich_ascent_preview
    prep, _ = fixture()
    prep['materials']['scenery_preferences'] = ['mountain']
    calls = []
    def unavailable(*args):
        calls.append(1)
        raise RuntimeError('unavailable')
    monkeypatch.setattr(single_day, '_elevation_profile', unavailable)
    def measure(*args, **kwargs):
        return {'distance_m': 30000, 'geometry': {'coordinates': [[135,35],[135.1,35.1],[135,35]]}}
    result = plan_with_feedback(prep, workspace_id='t', title='t', include_elevation=False,
        include_ascent=True, config={}, evaluator=measure, validator=lambda v,*a,**kw:deepcopy(v),
        pool_builder=lambda *a,**kw:prep['skeletons'])
    assert len(result['candidates']) == 1
    assert all(r['estimated_ascent_m'] is None for r in result['route_search']['measurements'])
    before = len(calls)
    enrich_ascent_preview(result, config={})
    assert len(calls) == before
