"""Semantic candidate selection; coordinates and identities remain provider-owned."""
from copy import deepcopy
import re
import unicodedata

CATEGORIES = {
    'natural': {'park', 'tourist_attraction', 'natural_feature', 'hiking_area', 'national_park'},
    'landmark': {'tourist_attraction', 'cultural_landmark', 'historical_landmark', 'monument', 'museum', 'place_of_worship'},
    'bridge': {'bridge'},
    'road': {'route', 'street_address', 'intersection'},
    'station': {'train_station', 'transit_station', 'subway_station', 'bus_station'},
    'business': {'store', 'restaurant', 'cafe', 'lodging', 'event_venue', 'service'},
    'unknown': set(),
}
BUSINESS = {'event_venue', 'lodging', 'hotel', 'restaurant', 'cafe', 'store', 'shopping_mall'}
# Weak compatibility requires name evidence; it cannot identify a place alone.
COMPATIBLE = {'bridge': {'route', 'tourist_attraction', 'historical_landmark'},
              'station': {'train_ticket_office', 'transportation_service'}}
LOCAL_LANGUAGES = {'JP': 'ja', 'FR': 'fr', 'DE': 'de', 'AT': 'de', 'IT': 'it'}


def normalized(value):
    return re.sub(r'[^\w]', '', unicodedata.normalize('NFKC', str(value)).casefold())


def choose_place(results, *, query, country, intent, locality_names=(), anchor=None, radius_km=None, origin_locality_evidence=None):
    from services.route.geometry import haversine_m
    from services.route.single_day import RouteCandidateRejected
    category = intent.get('category', 'unknown')
    expected = CATEGORIES.get(category, set())
    names = [normalized(s) for s in [intent.get('name', ''), intent.get('local_name', ''), query] if s]
    rows, rejected, candidates = [], [], []
    seen_ids = set()
    for index, item in enumerate(results):
        if item.get('id') and item['id'] in seen_ids:
            continue
        seen_ids.add(item.get('id'))
        reason = None
        spatial_origin = False
        types = set(item.get('types') or [])
        if item.get('country_code') != country:
            reason = 'country_mismatch'
        elif locality_names and not {normalized(n) for n in item.get('localities', [])} & {normalized(n) for n in locality_names}:
            center = (origin_locality_evidence or {}).get('location') or {}
            location = item.get('location') or {}
            # Missing city is not conflicting city evidence. Only the origin may
            # use a conservative city-center fallback; identity checks still apply.
            spatial_origin = bool(not item.get('localities') and center and location
                and origin_locality_evidence.get('country_code') == country
                and haversine_m([center['longitude'], center['latitude']],
                                [location['longitude'], location['latitude']]) <= 5000)
            if not spatial_origin:
                reason = 'locality_mismatch'
        if not reason and anchor and radius_km and haversine_m(
            [anchor['longitude'], anchor['latitude']],
            [item['location']['longitude'], item['location']['latitude']]) > radius_km * 1000:
            reason = 'outside_radius'
        if not reason and category not in {'business', 'unknown'} and types & BUSINESS and not types & expected:
            reason = 'category_conflict'
        name = normalized(item.get('name', ''))
        identity = 2 if name and name in names else int(bool(name) and any(n and (n in name or name in n) for n in names))
        semantic = 2 if types & expected else int(bool(identity and types & COMPATIBLE.get(category, set())))
        candidates.append({'place_id': item.get('id'), 'name': item.get('name'),
                           'address': item.get('address'), 'country_code': item.get('country_code'),
                           'localities': item.get('localities', []), 'types': sorted(types),
                           'identity_match': identity, 'category_score': semantic, 'rejection': reason})
        if reason:
            rejected.append({'place_id': item.get('id'), 'reason': reason})
            continue
        rows.append((identity, semantic, index, item, spatial_origin))
    rows.sort(key=lambda r: (-r[0], -r[1], r[2]))
    def reject(message, code, reason):
        error = RouteCandidateRejected(message, code=code, stage='place_resolution')
        error.place_resolution = {'query': query, 'category': category, 'reason': reason,
                                  'candidates': candidates[:5]}
        raise error
    if not rows:
        reject(f'地点 {query} 没有符合城市、范围和用途的候选', 'place_not_found', 'no_eligible_candidates')
    best = rows[0]
    # No substring bonus for sharing two arbitrary characters. A unique typed
    # candidate can bridge languages, but multiple equally plausible IDs cannot.
    selected_name = best[3].get('name', '')
    cjk = r'[\u3040-\u30ff\u3400-\u9fff]'
    cross_script = bool(re.search(cjk, query)) != bool(re.search(cjk, selected_name))
    typed_provider_match = best[1] == 2 and best[2] == 0 and cross_script
    if not best[0] and not typed_provider_match:
        reject(f'地点 {query} 身份不明确：候选名称缺少匹配依据', 'place_ambiguous', 'insufficient_identity')
    if len(rows) > 1 and rows[1][:2] == best[:2] and rows[1][3].get('id') != best[3].get('id'):
        reject(f'地点 {query} 身份不明确：多个候选同分，需核对地址与具体入口', 'place_ambiguous', 'ambiguous_candidates')
    result = deepcopy(best[3])
    result['resolution_evidence'] = {'status': 'resolved', 'category': category,
        'identity_match': best[0], 'category_match': bool(best[1]),
        'provider_rank': best[2] + 1, 'rejected': rejected,
        'origin_locality_match': 'city_center_radius_5km' if best[4] else ('city_name' if locality_names else None)}
    return result


def resolve_place(client, query, *, country, intent, locality_names=(), anchor=None, radius_km=None, origin_locality_evidence=None):
    from services.route.single_day import RouteCandidateRejected
    options = {'near': (anchor['latitude'], anchor['longitude']) if anchor else None,
               'radius_m': min(50000, (radius_km or 20) * 1000), 'limit': 5}
    attempts = []
    for attempt in range(2):
        text = query if attempt == 0 else ' '.join(dict.fromkeys(filter(None, [
            intent.get('local_name') or intent.get('name') or query,
            intent.get('description'), locality_names[0] if locality_names else country])))
        language = LOCAL_LANGUAGES.get(country, 'en')
        rows = client.search(text, **options, **({'language_code': language} if attempt else {})).get('places') or []
        attempts.append({'query': text, 'candidate_ids': [r.get('id') for r in rows]})
        try:
            selected = choose_place(rows, query=query, country=country, intent=intent,
                                    locality_names=locality_names, anchor=anchor, radius_km=radius_km,
                                    origin_locality_evidence=origin_locality_evidence)
            selected['resolution_evidence']['attempts'] = attempts
            return selected
        except RouteCandidateRejected as exc:
            attempts[-1]['diagnosis'] = deepcopy(getattr(exc, 'place_resolution', {}))
            if attempt:
                exc.place_resolution['attempts'] = attempts
                raise
