from copy import deepcopy
import pytest
from services.route import daily_itinerary as daily
from services.route.single_day import compact_route_plan
from services.route.view import build_route_plan_view
from storage.repositories.route import RoutePlanStore, RouteRevisionConflict


def make_plan():
    return daily.draft_itinerary(workspace_id='workspace',title='三日骑行',country_code='CN',candidates=[{'stages':[
        {'day':n,'label':f'第{n}天','waypoints':[str(n),str(n+1)],'distance_range_km':[50,100]} for n in range(1,4)]}])


def route(spec,**kwargs):
    assert kwargs['allow_distance_mismatch'] is True
    assert 'measurement_only' not in kwargs
    assert spec['target_distance_km']==100
    n=kwargs['index']
    return {'candidate_id':spec['candidate_id'],'name':spec['name'],'distance_m':40000,
            'distance_km':40,'duration_s':7200,'duration_min':120,'warnings':[],
            'geometry':{'type':'LineString','coordinates':[[100+n,30],[101+n,30]]},'waypoints':[]}


def test_draft_survives_restart_without_map_calls(monkeypatch):
    monkeypatch.setattr(daily,'route_candidate',lambda *a,**kw:pytest.fail('draft must not route'))
    store=RoutePlanStore();plan=store.save(make_plan())
    restored=RoutePlanStore().get(plan['plan_id'])
    assert len(restored['candidates'])==3
    assert all(d['day_status']=='pending' and 'geometry' not in d for d in restored['candidates'])
    assert build_route_plan_view(restored)['itinerary_schema_version']==daily.VERSION
    assert '尚无可用地图里程' in daily.itinerary_answer(compact_route_plan(restored))


def test_one_day_failure_preserves_other_day_and_retry(monkeypatch):
    monkeypatch.setattr(daily,'route_candidate',route)
    store=RoutePlanStore();p=store.save(make_plan())
    p=daily.update_day(store,p,operation='generate_day',candidate_id='day_1',expected_revision=p['revision'],args={})
    first=deepcopy(p['candidates'][0])
    assert first['distance_satisfied'] is False
    assert '未达到' in first['warnings'][0]
    assert '40.0 km' in daily.itinerary_answer(compact_route_plan(p))
    def fail(*a,**kw): raise RuntimeError('地图暂时不可用')
    monkeypatch.setattr(daily,'route_candidate',fail)
    p=daily.update_day(store,p,operation='generate_day',candidate_id='day_2',expected_revision=p['revision'],args={})
    assert p['candidates'][0]==first
    assert p['candidates'][1]['day_status']=='failed'
    assert p['active_candidate_id']=='day_2'
    assert p['candidates'][2]['day_status']=='pending'
    p=RoutePlanStore().get(p['plan_id'])
    monkeypatch.setattr(daily,'route_candidate',route)
    p=daily.update_day(store,p,operation='generate_day',candidate_id='day_2',expected_revision=p['revision'],args={})
    assert p['candidates'][1]['day_status']=='ready'
    assert p['candidates'][0]==first


def test_endpoint_edit_preserves_neighbour_route_and_reports_connection(monkeypatch):
    monkeypatch.setattr(daily,'route_candidate',route)
    store=RoutePlanStore();p=store.save(make_plan())
    for n in (1,2):
        p=daily.update_day(store,p,operation='generate_day',candidate_id=f'day_{n}',expected_revision=p['revision'],args={})
    neighbour=deepcopy(p['candidates'][1])
    p=daily.update_day(store,p,operation='edit_day',candidate_id='day_1',expected_revision=p['revision'],args={'waypoints':['1','Other']})
    assert p['candidates'][0]['day_status']=='needs_regeneration'
    assert p['candidates'][1]['day_status']=='ready'
    assert p['candidates'][1]['geometry']==neighbour['geometry']
    assert p['candidates'][1]['day_revision']==neighbour['day_revision']
    assert p['candidates'][1]['connection_warning']
    assert p['candidates'][2]['day_status']=='pending'
    assert p['candidates'][0]['distance_range_km']==[50,100]


def test_stale_revision_never_calls_map(monkeypatch):
    monkeypatch.setattr(daily,'route_candidate',lambda *a,**kw:pytest.fail('stale request must not route'))
    store=RoutePlanStore();p=store.save(make_plan())
    store.save(p,expected_revision=p['revision'])
    with pytest.raises(RouteRevisionConflict):
        daily.update_day(store,p,operation='generate_day',candidate_id='day_1',expected_revision=p['revision'],args={})


@pytest.mark.parametrize('bounds',[[100,50],[0,100],[50,float('inf')]])
def test_invalid_daily_range(bounds):
    with pytest.raises(ValueError):daily.normalize_day({'waypoints':['A','B'],'distance_range_km':bounds},1)


def test_day_constraints_merge_and_confirmation_survives_other_day_failure(monkeypatch):
    from integrations.provider_error import TransientProviderError
    from services.route.confirmation import _mark_confirmed
    captured=[]
    def resolve(spec, **kwargs):
        captured.append(kwargs)
        return {**route(spec, **kwargs), 'travel_mode':'BICYCLE'}
    monkeypatch.setattr(daily,'route_candidate',resolve)
    store=RoutePlanStore(); p=store.save(make_plan())
    p=daily.update_day(store,p,operation='edit_day',candidate_id='day_1',expected_revision=p['revision'],
        args={'route_constraints':{'avoid_ferry':True},'route_preferences':{'turn_bias':'fewer_left'}})
    p=daily.update_day(store,p,operation='generate_day',candidate_id='day_1',expected_revision=p['revision'],args={})
    assert captured[0]['route_constraints']['avoid_ferry'] is True
    assert captured[0]['route_preferences']['turn_bias']=='fewer_left'
    p=store.save(_mark_confirmed(p,'day_1'),expected_revision=p['revision'])
    first=deepcopy(p['candidates'][0])
    failure=TransientProviderError('地图繁忙',provider='amap',stage='route',code='rate_limit')
    def fail(*a,**kw): raise failure
    monkeypatch.setattr(daily,'route_candidate',fail)
    p=daily.update_day(store,p,operation='generate_day',candidate_id='day_2',expected_revision=p['revision'],args={})
    assert p['candidates'][0]==first
    assert p['candidates'][1]['failure']==failure.to_failure()
    view=build_route_plan_view(RoutePlanStore().get(p['plan_id']))
    assert view['candidates'][0]['confirmed'] is True
    assert view['candidates'][1]['confirmed'] is False
    p=daily.update_day(store,p,operation='edit_day',candidate_id='day_1',expected_revision=p['revision'],args={'target_distance_km':70})
    assert build_route_plan_view(p)['candidates'][0]['confirmed'] is False


def test_legacy_confirmation_migrates_when_another_day_is_confirmed():
    from services.route.confirmation import _mark_confirmed
    p=make_plan();p['revision']=4
    for day in p['candidates']:day['day_status']='ready'
    p['planning']={'status':'confirmed','confirmed_candidate_id':'day_1'}
    p=_mark_confirmed(p,'day_2')
    assert [c['confirmed'] for c in build_route_plan_view(p)['candidates']]==[True,True,False]


def test_drive_duration_is_never_labeled_cycling():
    p=make_plan();p['candidates'][0].update(day_status='ready',travel_mode='DRIVE',distance_m=40000,duration_s=1800)
    assert '地图驾车时间（虚拟观景路径） 0.5 小时' in daily.itinerary_answer(p)
    assert '预计骑行 0.5' not in daily.itinerary_answer(p)


@pytest.mark.parametrize('value',[[],{'unsupported':True}])
def test_unknown_daily_constraints_rejected_before_persistence(value):
    store=RoutePlanStore();p=store.save(make_plan())
    with pytest.raises(ValueError,match='不支持'):
        daily.update_day(store,p,operation='generate_day',candidate_id='day_1',expected_revision=p['revision'],args={'route_constraints':value})
    assert store.get(p['plan_id'])['revision']==p['revision']


def test_distance_relaxation_still_rejects_ferry(monkeypatch):
    from services.route import single_day
    def provider(*a,**kw):
        return [], {'geometry':{'type':'LineString','coordinates':[[104,30],[104.1,30.1]]},
            'distance_m':40000,'duration_s':7200,'provider':'amap','travel_mode':'BICYCLE',
            'instructions':[{'action':'直行','assistant_action':'','road':'轮渡','walk_type':'30'}]}
    monkeypatch.setattr(single_day,'_route_amap',provider)
    spec={'name':'路线','waypoints':['A','B'],'target_distance_km':100}
    options=dict(index=1,country_code='CN',include_elevation=False,config={},allow_distance_mismatch=True)
    result=single_day.route_candidate(spec,**options)
    assert result['distance_m']==40000
    with pytest.raises(single_day.RouteCandidateRejected,match='轮渡'):
        single_day.route_candidate(spec,**options,route_constraints={'avoid_ferry':True})


def test_google_daily_preferences_are_rejected_explicitly(monkeypatch):
    monkeypatch.setattr(daily,'use_amap_routes',lambda *a:False)
    monkeypatch.setattr(daily,'route_candidate',lambda *a,**kw:pytest.fail('unsupported preference must not route'))
    store=RoutePlanStore();p=store.save(make_plan())
    p=daily.update_day(store,p,operation='generate_day',candidate_id='day_1',expected_revision=p['revision'],
        args={'route_preferences':{'turn_bias':'fewer_left'}})
    assert p['candidates'][0]['day_status']=='failed'
    assert 'Google' in p['candidates'][0]['failure']['message']


@pytest.mark.parametrize('confirmed', [False, True])
def test_align_second_day_preserves_first_day_draft_across_restart(monkeypatch, confirmed):
    from services.route.confirmation import _mark_confirmed
    calls=[]
    def resolve(spec, **kwargs):
        calls.append(spec['candidate_id'])
        return route(spec, **kwargs)
    monkeypatch.setattr(daily,'route_candidate',resolve)
    store=RoutePlanStore();p=store.save(make_plan())
    p=daily.update_day(store,p,operation='edit_day',candidate_id='day_1',expected_revision=p['revision'],args={'waypoints':['1','Lake']})
    p=daily.update_day(store,p,operation='generate_day',candidate_id='day_1',expected_revision=p['revision'],args={})
    if confirmed:
        p=store.save(_mark_confirmed(p,'day_1'),expected_revision=p['revision'])
    first=deepcopy(p['candidates'][0])
    assert p['candidates'][1]['connection_warning']
    p=daily.update_day(store,p,operation='edit_day',candidate_id='day_2',expected_revision=p['revision'],args={'waypoints':['Lake','3']})
    restored=RoutePlanStore().get(p['plan_id'])
    assert restored['candidates'][0]==first
    assert restored['candidates'][1]['connection_warning'] is None
    assert restored['candidates'][1]['day_status']=='needs_regeneration'
    view=build_route_plan_view(restored)
    assert view['candidates'][0]['day_status']=='ready'
    assert view['candidates'][0]['geometry']['coordinates']==first['geometry']['coordinates']
    assert view['candidates'][0]['confirmed'] is confirmed
    assert calls==['day_1']
    p=daily.update_day(store,restored,operation='generate_day',candidate_id='day_2',expected_revision=restored['revision'],args={})
    assert p['candidates'][0]==first
    assert calls==['day_1','day_2']


@pytest.mark.parametrize('args', [{}, {'waypoints':['1','2']}, {'candidate_name':'新名称'}])
def test_metadata_and_noop_keep_confirmed_geometry(monkeypatch, args):
    from services.route.confirmation import _mark_confirmed
    monkeypatch.setattr(daily,'route_candidate',route)
    store=RoutePlanStore();p=store.save(make_plan())
    p=daily.update_day(store,p,operation='generate_day',candidate_id='day_1',expected_revision=p['revision'],args={})
    p=store.save(_mark_confirmed(p,'day_1'),expected_revision=p['revision'])
    before=deepcopy(p['candidates'][0])
    monkeypatch.setattr(daily,'route_candidate',lambda *a,**kw:pytest.fail('edit must not route'))
    p=daily.update_day(store,p,operation='edit_day',candidate_id='day_1',expected_revision=p['revision'],args=args)
    day=p['candidates'][0]
    assert day['geometry']==before['geometry']
    assert day['day_revision']==before['day_revision']
    assert day['confirmation']==before['confirmation']
    assert build_route_plan_view(p)['candidates'][0]['confirmed'] is True


def test_distance_edit_rechecks_without_routing_and_removes_old_warning(monkeypatch):
    monkeypatch.setattr(daily,'route_candidate',route)
    store=RoutePlanStore();p=store.save(make_plan())
    p=daily.update_day(store,p,operation='generate_day',candidate_id='day_1',expected_revision=p['revision'],args={})
    geometry=deepcopy(p['candidates'][0]['geometry'])
    monkeypatch.setattr(daily,'route_candidate',lambda *a,**kw:pytest.fail('distance edit must not route'))
    p=daily.update_day(store,p,operation='edit_day',candidate_id='day_1',expected_revision=p['revision'],args={'distance_range_km':[30,50]})
    day=p['candidates'][0]
    assert day['day_status']=='ready' and day['geometry']==geometry
    assert day['distance_satisfied'] is True
    assert not day['warnings']


@pytest.mark.parametrize('edit', [False, True])
def test_failed_regeneration_retains_separate_preview_and_cannot_confirm(monkeypatch, edit):
    from services.route.confirmation import _candidate_view
    monkeypatch.setattr(daily,'route_candidate',route)
    store=RoutePlanStore();p=store.save(make_plan())
    p=daily.update_day(store,p,operation='generate_day',candidate_id='day_1',expected_revision=p['revision'],args={})
    first=deepcopy(p['candidates'][0])
    if edit:
        p=daily.update_day(store,p,operation='edit_day',candidate_id='day_1',expected_revision=p['revision'],args={'waypoints':['1','Lake','2']})
        assert p['candidates'][0]['last_successful_route']['route']=={k:v for k,v in first.items() if k!='connection_warning'}
    def fail(*a,**kw):raise RuntimeError('map down')
    monkeypatch.setattr(daily,'route_candidate',fail)
    for _ in range(2):
        p=daily.update_day(store,p,operation='generate_day',candidate_id='day_1',expected_revision=p['revision'],args={})
        p=RoutePlanStore().get(p['plan_id'])
        day=p['candidates'][0]
        assert day['day_status']=='failed'
        assert 'distance_m' not in day and 'distance_satisfied' not in day and 'geometry' not in day
        previous=build_route_plan_view(p)['candidates'][0]['previous_route']
        assert previous['geometry']==first['geometry'] and previous['distance_m']==40000
        assert '上次成功路线' in daily.itinerary_answer(compact_route_plan(p))
        with pytest.raises(ValueError):_candidate_view(p,'day_1')
    monkeypatch.setattr(daily,'route_candidate',route)
    p=daily.update_day(store,p,operation='generate_day',candidate_id='day_1',expected_revision=p['revision'],args={})
    assert p['candidates'][0]['day_status']=='ready'
    assert 'last_successful_route' not in p['candidates'][0]
