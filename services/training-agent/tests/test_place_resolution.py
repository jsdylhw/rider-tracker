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
