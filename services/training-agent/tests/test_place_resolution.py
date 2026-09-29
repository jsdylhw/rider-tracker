import pytest
from integrations.provider_error import TransientProviderError
from services.route.place_resolution import choose_place, resolve_place
from services.route.single_day import RouteCandidateRejected


def place(name, types, id='a', city='Kyoto'):
    return {'id': id, 'name': name, 'types': types, 'country_code': 'JP',
            'localities': [city], 'location': {'latitude': 35, 'longitude': 135}}


def choose(rows, category='natural', **kwargs):
    return choose_place(rows, query='鴨川デルタ 京都市', country='JP',
                        intent={'category': category, **kwargs}, locality_names=['Kyoto'])


def test_cross_language_nature_beats_same_name_business():
    rows = [place('Kamogawa Delta', ['park', 'tourist_attraction']),
            place('貸会議室鴨川デルタ', ['event_venue'], 'b')]
    result = choose(rows)
    assert result['id'] == 'a'
    assert result['resolution_evidence']['rejected'][0]['reason'] == 'category_conflict'


def test_explicit_business_is_not_blacklisted():
    assert choose([place('貸会議室鴨川デルタ', ['event_venue'])], category='business', name='貸会議室鴨川デルタ')['id'] == 'a'


def test_city_filtered_before_selecting_identity():
    rows = [place('鴨川デルタ', ['park'], city='Osaka'), place('Kamogawa Delta', ['park'], 'b')]
    assert choose(rows, name='Kamogawa Delta')['id'] == 'b'


def test_multiple_typed_candidates_require_identity():
    with pytest.raises(RouteCandidateRejected, match='身份不明确'):
        choose([place('Park A', ['park']), place('Park B', ['park'], 'b')])


def test_no_type_or_name_evidence_is_not_a_success():
    with pytest.raises(RouteCandidateRejected):
        choose([place('Unrelated', ['point_of_interest'])], category='unknown')


def test_bounded_retry_and_evidence():
    class Client:
        calls = []
        def search(self, q, **kwargs):
            self.calls.append((q, kwargs))
            return {'places': [place('meeting room', ['event_venue'])] if len(self.calls)==1 else [place('Kamogawa Delta', ['park'])]}
    c = Client()
    result = resolve_place(c, '鴨川デルタ', country='JP', intent={'category':'natural', 'description':'合流点'}, locality_names=['Kyoto'])
    assert len(c.calls) == 2 and c.calls[1][1]['language_code'] == 'ja'
    assert len(result['resolution_evidence']['attempts']) == 2


def test_network_error_remains_provider_error():
    class Client:
        def search(self,*a,**kw): raise TransientProviderError('unavailable')
    with pytest.raises(TransientProviderError):
        resolve_place(Client(), 'q', country='JP', intent={})


def test_same_language_unrelated_park_is_not_resolved_by_type_alone():
    with pytest.raises(RouteCandidateRejected):
        choose_place([place('Unrelated Park', ['park'])], query='Kyoto Gardens', country='JP',
                     intent={'category':'natural'}, locality_names=['Kyoto'])


def test_named_bridge_compatible_road_beats_untyped_result():
    rows = [place('Ponte Milvio', ['point_of_interest'], 'other'),
            place('Ponte Milvio', ['route'], 'bridge')]
    result = choose_place(rows, query='Ponte Milvio, Kyoto', country='JP',
                          intent={'name': 'Ponte Milvio', 'category': 'bridge'})
    assert result['id'] == 'bridge'
    with pytest.raises(RouteCandidateRejected):
        choose_place([place('Unrelated Road', ['route'])], query='Ponte Milvio', country='JP',
                     intent={'category': 'bridge'})


def test_duplicate_provider_id_is_not_ambiguity_but_distinct_ids_are():
    row = place('鴨川デルタ', ['park'])
    assert choose([row, dict(row)])['id'] == 'a'
    with pytest.raises(RouteCandidateRejected) as caught:
        choose([row, {**row, 'id': 'b', 'address': 'another entrance'}])
    evidence = caught.value.to_tool_result()['place_resolution']
    assert evidence['reason'] == 'ambiguous_candidates'
    assert evidence['candidates'][1]['address'] == 'another entrance'


def test_failure_preserves_both_queries_and_rejection_reasons():
    class Client:
        calls = []
        def search(self, query, **kwargs):
            self.calls.append(kwargs)
            return {'places': [place('Ponte Milvio', ['route'])]}
    client = Client()
    with pytest.raises(RouteCandidateRejected) as caught:
        resolve_place(client, 'Ponte Milvio, Roma', country='IT',
                      intent={'name': 'Ponte Milvio', 'category': 'bridge'})
    evidence = caught.value.to_tool_result()['place_resolution']
    assert client.calls[1]['language_code'] == 'it'
    assert len(evidence['attempts']) == 2
    assert evidence['candidates'][0]['rejection'] == 'country_mismatch'
