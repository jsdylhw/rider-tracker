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
