import pytest
from services.route.place_resolution import choose_place
from services.route.single_day import RouteCandidateRejected
from services.route import preparation, single_day
from services.route.requirements import merge_material_requirements


def row(name, lon=7.27, city='Nice', country='FR'):
    return {'id':name, 'name':name, 'country_code':country, 'localities':[city] if city else [],
            'types':['tourist_attraction'], 'location':{'longitude':lon,'latitude':43.7}}


def test_missing_city_origin_needs_nearby_identity_and_no_conflicting_evidence():
    evidence={'country_code':'FR','location':{'longitude':7.27,'latitude':43.7}}
    options=dict(query='Cathedral',country='FR',intent={'name':'Cathedral','category':'landmark'},
                 locality_names=('Nice',),origin_locality_evidence=evidence)
    result=choose_place([row('Cathedral',city=None)],**options)
    assert result['resolution_evidence']['origin_locality_match']=='city_center_radius_5km'
    for bad in (row('Cathedral',lon=8,city=None),row('Cathedral',city='Other'),
                row('Cathedral',city=None,country='IT'),row('Unrelated',city=None)):
        with pytest.raises(RouteCandidateRejected): choose_place([bad],**options)
    with pytest.raises(RouteCandidateRejected):
        choose_place([row('Cathedral',city=None)],**{**options,'origin_locality_evidence':None})


def materials(scope='origin'):
    return {'country_code':'FR','locality':'Nice','locality_scope':scope,'is_loop':True,
            'target_distance_km':40,'origin_id':'a','points':[
                {'id':'a','query':'Start','required':True,'source_ids':[]},
                {'id':'b','query':'Harbor','required':True,'source_ids':[]}]}


@pytest.mark.parametrize('scope,lon,accepted',[('origin',7.31,True),('city',7.31,False),('origin',8,False),
                                                ('origin',7.565,True),('origin',7.58,False)])
def test_material_resolution_allows_nearby_town_but_not_wrong_city_or_distant_point(monkeypatch,scope,lon,accepted):
    class Client:
        def search(self, query, **kwargs):
            return {'places':[row('Start') if query.startswith('Start') else row('Harbor',lon,city='Villefranche-sur-Mer')]}
    monkeypatch.setattr(single_day,'GooglePlacesClient',lambda key:Client())
    monkeypatch.setattr(preparation,'resolve_google_locality',lambda *a:{'country_code':'FR','query':'Nice','names':['Nice'],'location':{'longitude':7.27,'latitude':43.7}})
    if accepted:
        result=preparation.resolve_material_points(materials(scope),config={'google':{'api_key':'test'}})
        assert result['b']['place']['localities']==['Villefranche-sur-Mer']
    else:
        with pytest.raises(RouteCandidateRejected):
            preparation.resolve_material_points(materials(scope),config={'google':{'api_key':'test'}})


def test_city_scope_inherits_until_explicitly_changed():
    old=materials('city');new=materials('origin')
    assert merge_material_requirements(new,old)['locality_scope']=='city'
    assert merge_material_requirements(new,old,{'fields':['locality_scope']})['locality_scope']=='origin'


@pytest.mark.parametrize('longitude,accepted',[(120.1,True),(120.5,False)])
def test_amap_radius_uses_display_wgs84_coordinates(monkeypatch,longitude,accepted):
    m=materials();m['country_code']='CN';m.pop('locality')
    def search(query,*args,**kwargs):
        return {'query':query,'name':query,'longitude':130,'latitude':40,
                'display_longitude':120 if query=='Start' else longitude,'display_latitude':30}
    monkeypatch.setattr(preparation,'_search_amap_place',search)
    if accepted:
        assert len(preparation.resolve_material_points(m,config={'amap':{'web_service_key':'test'}}))==2
    else:
        with pytest.raises(RouteCandidateRejected,match='范围'):
            preparation.resolve_material_points(m,config={'amap':{'web_service_key':'test'}})


def test_legacy_city_restriction_is_not_silently_relaxed_on_refine():
    old=materials('city');old.pop('locality_scope')
    assert merge_material_requirements(materials(),old)['locality_scope']=='city'


@pytest.mark.parametrize('scope,expected_region',[('origin',''),('city','028')])
def test_amap_search_city_limit_only_for_explicit_city_scope(monkeypatch,scope,expected_region):
    m=materials(scope);m.update(country_code='CN',locality='成都市',target_distance_km=1000)
    calls=[]
    def search(query,key,**kwargs):
        calls.append(kwargs)
        return {'query':query,'name':query,'longitude':104.06 if query=='Start' else 102.8,
                'latitude':30.65,'citycode':'028','localities':['成都市']}
    monkeypatch.setattr(preparation,'_search_amap_place',search)
    preparation.resolve_material_points(m,config={'amap':{'web_service_key':'test'}})
    assert calls[1]['region']==expected_region


def test_direct_amap_route_still_rejects_points_outside_target_radius(monkeypatch):
    def search(query,*args,**kwargs):
        return {'name':query,'latitude':30.65,'longitude':104.06 if query=='Start' else 102.8}
    monkeypatch.setattr(single_day,'_search_amap_place',search)
    with pytest.raises(RouteCandidateRejected,match='超过起点范围'):
        single_day._route_amap(['Start','Far'],False,{'amap':{'web_service_key':'test'}},
                              target_distance_km=10)


def test_google_override_resolves_chinese_materials_with_google(monkeypatch):
    m=materials();m.update(country_code='CN');m.pop('locality')
    def unexpected(*args,**kwargs):
        raise AssertionError('AMap must not be called')
    monkeypatch.setattr(preparation,'_search_amap_place',unexpected)
    calls=[]
    def resolve(queries,country,*args,**kwargs):
        calls.append(country)
        return [{'query':queries[-1],'name':queries[-1],'longitude':104.06,'latitude':30.65}]
    monkeypatch.setattr(preparation,'resolve_google_places',resolve)
    assert len(preparation.resolve_material_points(m,config={'route_provider_override':'google'}))==2
    assert calls==['CN','CN']


def test_google_override_routes_cn_and_converts_cached_amap_coordinates(monkeypatch):
    from services.route.provider_readiness import use_amap_routes
    assert use_amap_routes('CN',{})
    assert not use_amap_routes('CN',{'route_provider_override':'google'})
    assert not use_amap_routes('FR',{})
    class Routed(Exception): pass
    class Client:
        def __init__(self,key): pass
        def route(self,points,*,country_code):
            assert country_code=='CN'
            assert points[0].lon==104.05
            assert points[0].lat==30.64
            raise Routed()
    monkeypatch.setattr(single_day,'GoogleRoutesClient',Client)
    monkeypatch.setattr(single_day,'ensure_google_route_provider_ready',lambda config:None)
    points=[{'query':q,'latitude':30.65,'longitude':104.06,
             'display_latitude':30.64,'display_longitude':104.05} for q in ['a','b']]
    with pytest.raises(Routed):
        single_day.route_candidate({'waypoints':['a','b'],'_resolved_places':points},index=1,
            country_code='CN',include_elevation=False,config={'route_provider_override':'google'})
    assert points[0]['longitude']==104.06
