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
