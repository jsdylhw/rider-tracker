from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from agent.analysis.prompts import build_fit_analysis_system_prompt
from fit.analysis.stairs import detect_stair_sets, stair_summary
from fit.analysis.segments import scan_activity_segments
from fit.analysis.features import build_activity_features
from fit.analysis.data import get_activity_summary_tool


def activity(points, step=1):
    times = np.arange(0, points[-1][0] + 1, step)
    values = np.interp(times, *zip(*points))
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return {"summary": {"sport_type": "floor_climbing"},
            "sessions": [{"total_timer_time": float(times[-1]), "total_ascent": 100}],
            "records": [{"timestamp": start + timedelta(seconds=float(t)), "heart_rate": float(h)} for t, h in zip(times, values)]}


def test_two_cycles_and_incomplete_last_set():
    parsed = activity([(0,100),(60,160),(120,105),(180,165),(240,110),(300,160)])
    result = scan_activity_segments(parsed)
    assert result['summary']['estimated_set_count'] == 3
    assert [r['recovery_complete'] for r in result['efforts']] == [True, True, False]
    assert all(r['estimated'] and 'elevation_gain_m' not in r for r in result['efforts'])
    assert result['segments'] == []  # HR alone must not create measured road climbs.
    stored = build_activity_features(parsed)
    assert stored['effort_candidates']['baselines']['scan_basis'] == 'heart_rate'
    assert len(stored['effort_candidates']['efforts']) == 3


@pytest.mark.parametrize('points', [ [(0,140),(300,140)], [(0,140),(100,140),(101,180),(102,140),(300,140)], [(0,140),(60,145),(120,140),(180,145)] ])
def test_flat_noise_and_single_spike_are_not_sets(points):
    assert detect_stair_sets(activity(points))['summary']['estimated_set_count'] == 0


def test_missing_and_other_sports():
    assert not detect_stair_sets({'summary':{'sport_type':'floor_climbing'}})['available']
    parsed=activity([(0,100),(60,160),(120,100)])
    parsed['summary']['sport_type']='cycling'
    assert detect_stair_sets(parsed)['reason']=='unsupported_sport'


def test_gap_does_not_complete_a_recovery():
    parsed=activity([(0,100),(60,160),(120,100),(180,160)])
    parsed['records'] = parsed['records'][:61] + parsed['records'][120:]
    result=detect_stair_sets(parsed)
    assert result['summary']['gap_count']==1
    assert not any(s['recovery_complete'] for s in result['efforts'])
    assert all(s['recovery_end_s'] <= 60 or s['start_s'] >=120 for s in result['efforts'])


def test_sparse_sampling_retains_cycle_boundaries_and_time_mean():
    points=[(0,100),(60,160),(120,100),(180,160)]
    dense=detect_stair_sets(activity(points))['efforts']
    sparse=detect_stair_sets(activity(points,step=5))['efforts']
    assert len(dense)==len(sparse)
    assert [s['avg_hr_bpm'] for s in dense] == [s['avg_hr_bpm'] for s in sparse]
    limited=detect_stair_sets(activity(points),max_segments=1)
    assert limited['summary']['truncated'] and limited['summary']['estimated_set_count']==2


def test_summary_uses_session_zones_once_and_skill_is_shared():
    parsed=activity([(0,100),(60,160),(120,100)])
    parsed['training_metadata']={'time_in_zone':[
        {'reference_mesg':'lap','time_in_hr_zone':[60,60]},
        {'reference_mesg':'session','time_in_hr_zone':[60,60], 'hr_zone_high_boundary':[135,165], 'hr_calc_type':'percent_hrr'}]}
    summary=get_activity_summary_tool(parsed)['stair_climbing']
    assert summary['hr_zone_seconds']==[60,60]
    assert summary['hr_zone_percentages']==[50,50]
    assert summary['whole_session_ascent_m_per_min']==50
    assert '爬楼做组分析' in build_fit_analysis_system_prompt('floor_climbing')
    assert '爬楼做组分析' not in build_fit_analysis_system_prompt('cycling')


def test_legacy_stair_features_rescan_without_writing(monkeypatch, tmp_path):
    import services.activity.analysis as service
    parsed=activity([(0,100),(60,160),(120,100),(180,160)])
    class Store:
        def get_activity(self, _): return {'sport_type':'floor_climbing','fit_path':str(tmp_path/'test.fit')}
        def get_facts(self, _): return {'features':{'schema_version':'activity_features.v1','effort_candidates':{'baselines':{'scan_basis':'power'},'efforts':[]}}}
    (tmp_path/'test.fit').touch()
    monkeypatch.setattr(service,'ActivityStore',Store)
    monkeypatch.setattr(service,'parse_fit',lambda _:parsed)
    result=service.discover_activity_segments('test',{'segment_type':'interval'})
    assert result['count']==2
    assert result['segments'][0]['detector']=='stair_hr_cycles.v1'
    assert result['segments'][0]['estimated'] is True


def test_report_rebuild_refreshes_legacy_stair_facts_before_model(tmp_path, monkeypatch):
    from agent.analysis import agent
    path=tmp_path/'stairs.fit'
    path.touch()
    parsed=activity([(0,100),(60,160),(120,100),(180,160)])
    class Store:
        def __init__(self, *_): pass
        def get_activity(self, _): return {'sport_type':'floor_climbing','fit_path':str(path)}
        def get_report(self, _): return None
        def get_facts(self, _): return {'metrics':{},'features':{'schema_version':'activity_features.v1'}}
    def analyze(*args, **kwargs):
        features=kwargs['facts']['features']
        assert features['stair_climbing']['total_ascent_m']==100
        assert len(features['effort_candidates']['efforts'])==2
        return {'markdown_report':'test','strava_summary':'test','analysis_summary':{}}
    monkeypatch.setattr(agent,'ActivityStore',Store)
    monkeypatch.setattr(agent,'parse_fit',lambda _:parsed)
    monkeypatch.setattr(agent,'analyze_with_llm',analyze)
    result=agent.analyze_fit_file(path,force=True,persist=False,activity_key='stairs')
    assert result['activity_features']['effort_candidates']['summary']['estimated_set_count']==2


def test_zone_labels_preserve_boundaries_and_unknowns():
    parsed=activity([(0,100),(60,160)])
    parsed['training_metadata']={'time_in_zone':[{'reference_mesg':'session',
        'time_in_hr_zone':[10,20,30], 'hr_zone_high_boundary':[135,145]}]}
    rows=stair_summary(parsed)['hr_zone_rows']
    assert [r['range_label'] for r in rows]==['135 bpm 以下','135–145 bpm','145 bpm 以上']
    assert [r['duration_s'] for r in rows]==[10,20,30]
    parsed['training_metadata']['time_in_zone'][0]['hr_zone_high_boundary']=[145,135]
    assert all(r['range_label']=='边界未知' for r in stair_summary(parsed)['hr_zone_rows'])
    assert stair_summary(parsed)['interpretation_limits']['relative_load']=='unavailable_without_comparable_history'


def test_cross_set_comparisons_include_first_set_but_exclude_unfinished_recovery():
    parsed=activity([(0,100),(60,145),(120,105),(180,170),(240,110),(300,160)])
    result=detect_stair_sets(parsed)
    comparison=result['summary']['comparisons']
    assert comparison['all_set_peak_hr_range_bpm']==[145,170]
    assert comparison['complete_recovery_count']==2
    assert comparison['incomplete_recovery_count']==1
    assert comparison['complete_recovery_duration_range_s'][0]>0
