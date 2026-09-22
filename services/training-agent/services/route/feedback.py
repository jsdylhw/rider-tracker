"""Bounded, provider-neutral skeleton evaluation and distance feedback.

Straight connectors are estimates. Only full provider measurements can become
published candidates; unsuccessful measurements remain diagnostic evidence.
"""
from copy import deepcopy
import math
from statistics import median
import time
from uuid import uuid4

from integrations.provider_error import ProviderError
from services.route.geometry import haversine_m
from services.route.quality import normalize_route_constraints, normalize_route_preferences
from services.route.single_day import RouteCandidateRejected, RouteProviderFailed


def geometry_cells(coordinates, latitude):
    """Resampled ~50m spatial proxy, not road identity or corridor proof."""
    cells = set()
    scale = max(.01, math.cos(math.radians(latitude)))
    for a, b in zip(coordinates, coordinates[1:]):
        count = max(1, min(10000, math.ceil(haversine_m(a, b) / 25)))
        for i in range(count + 1):
            t = i / count
            lon, lat = a[0] + t * (b[0]-a[0]), a[1] + t * (b[1]-a[1])
            cells.add((round(lon * 111320 * scale / 50), round(lat * 111320 / 50)))
    return cells


def similarity(first, second):
    return len(first & second) / max(1, len(first | second))


def route_signature(ids):
    ids = tuple(ids)
    return min(ids, tuple(reversed(ids))) if ids and ids[0] == ids[-1] else ids


def plan_with_feedback(preparation, *, workspace_id, title, include_elevation,
                       route_constraints=None, route_preferences=None, config=None, include_ascent=False,
                       evaluator=None, validator=None, pool_builder=None, clock=time.monotonic):
    from services.route.single_day import route_candidate, validate_measured_candidate
    from services.route.skeleton_search import rank_skeletons
    from integrations.route_providers.budget import route_request_budget
    from settings import load_config
    cfg = config if config is not None else load_config()
    evaluate = evaluator or route_candidate
    validate = validator or validate_measured_candidate
    search = pool_builder or rank_skeletons
    materials, points = preparation['materials'], preparation['points']
    target = float(materials.get('target_distance_km') or 0) * 1000
    seed = preparation.get('seed_point_ids') or []
    mountain = 'mountain' in materials.get('scenery_preferences', [])
    ascent_evaluations = 0
    constraints = normalize_route_constraints(route_constraints)
    preferences = normalize_route_preferences(route_preferences)
    from services.route.provider_readiness import use_amap_routes
    if evaluator is None and not use_amap_routes(materials['country_code'], cfg):
        from services.route.provider_readiness import ensure_google_route_provider_ready
        ensure_google_route_provider_ready(cfg)
    latitude = points[materials['origin_id']]['coordinate'][1]
    started = clock()
    measurements, failures, valid, seen = [], [], [], set()
    # Count routing and elevation HTTP attempts independently of full-route evaluations.
    pool = preparation['skeletons']
    ratio = None
    seed_edges = {frozenset(pair) for pair in zip(seed, seed[1:])}

    def retention(skeleton):
        edges = {frozenset(pair) for pair in zip(skeleton['point_ids'], skeleton['point_ids'][1:])}
        return len(edges & seed_edges) / max(1, len(seed_edges))

    def shortlist(rows, estimate_target):
        rows = [s for s in rows if not any(leg['kind'] == 'segment' for leg in s['legs'])
                and route_signature(s['point_ids']) not in seen]
        chosen = []
        # Preserve different length bands before feedback; do not query three
        # identical straight-distance optima. Ratio is turn-local, never global.
        aims = [estimate_target * .8, estimate_target, estimate_target * .65] if ratio is None and target else [estimate_target] * 3
        for aim in aims:
            if not rows:
                break
            def key(s):
                edges = {frozenset(pair) for pair in zip(s['point_ids'], s['point_ids'][1:])}
                overlap = max((similarity(edges, {frozenset(pair) for pair in zip(c['point_ids'], c['point_ids'][1:])}) for c in chosen), default=0)
                fit = abs(s['estimated_distance_m'] - aim) / aim if aim else 0
                best_preference = max(float(x.get('preferred_score', 0)) for x in rows)
                preference_gap = (best_preference - float(s.get('preferred_score', 0))) / max(1, best_preference)
                return (fit + overlap * .2 + preference_gap * .25 - retention(s) * .03, tuple(s['point_ids']))
            pick = min(rows, key=key)
            chosen.append(pick)
            sig = route_signature(pick['point_ids'])
            rows = [s for s in rows if route_signature(s['point_ids']) != sig]
        return chosen

    with route_request_budget(max_requests=72, timeout_s=90) as budget:
        for round_index in range(2):
            estimate_target = target / ratio if target and ratio else target
            if round_index:
                pool = search(materials, points, limit=24, estimated_target_m=estimate_target or None,
                              seed_point_ids=seed)
            for skeleton in shortlist(pool, estimate_target):
                if clock() - started >= 90:
                    break
                ids = skeleton['point_ids']
                seen.add(route_signature(ids))
                record = {'round': round_index + 1, 'point_ids': ids,
                          'estimated_distance_m': skeleton['estimated_distance_m'],
                          'control_corridor_coverage': skeleton.get('control_corridor_coverage', {}),
                          'preferred_score': skeleton.get('preferred_score', 0),
                          'selected_route_retention': retention(skeleton)}
                measurements.append(record)
                spec = {'name': f'本地候选 {len(measurements)}', 'waypoints': [points[i]['query'] for i in ids],
                        'target_distance_km': materials.get('target_distance_km'),
                        '_resolved_places': [deepcopy(points[i]['place']) for i in ids]}
                try:
                    measured = evaluate(spec, index=len(measurements), country_code=materials['country_code'],
                                        include_elevation=False, config=cfg, route_constraints=constraints,
                                        route_preferences=preferences, measurement_only=True, provider_preflight_completed=True)
                except ProviderError as exc:
                    record.update(status='provider_error', diagnostic=exc.to_failure())
                    failures.append(exc.to_failure())
                    if exc.code == 'route_budget_exhausted':
                        break
                    continue
                except RouteCandidateRejected as exc:
                    record.update(status='rejected', message=str(exc))
                    continue
                actual = float(measured['distance_m'])
                record.update(actual_distance_m=actual, actual_mode=measured.get('travel_mode'),
                              geometry=measured.get('geometry'), status='measured')
                error = abs(actual - target) / target if target else 0
                record['distance_error_ratio'] = error
                if error > .20:
                    record.update(status='distance_rejected', message='实际距离超出目标 ±20%，保留测量用于反馈。')
                    continue
                try:
                    accepted = validate(measured, constraints, include_elevation=False, config=cfg)
                except RouteCandidateRejected as exc:
                    record.update(status='quality_rejected', message=str(exc))
                    continue
                record['status'] = 'accepted'
                if include_ascent:
                    from services.route.ascent import enrich_ascent_preview, ascent_view
                    ascent_evaluations += 1
                    accepted = enrich_ascent_preview({'candidates': [accepted]}, config=cfg)['candidates'][0]
                    preview = ascent_view(accepted)
                    record['estimated_ascent_m'] = preview['ascent_m'] if preview else None
                    # A bounded preference bonus, never a claim of scenic coverage.
                    # Saturate at 20 m/km so extreme climbs do not dominate distance.
                    record['mountain_bonus'] = (.15 * min(1, preview['ascent_m'] / max(1, actual / 1000) / 20)
                                                if mountain and preview else 0)
                record['ranking_score'] = error - record.get('mountain_bonus', 0)
                accepted['planning_evidence'] = {k: record[k] for k in ('control_corridor_coverage', 'distance_error_ratio', 'selected_route_retention')}
                accepted['planning_evidence']['corridor_geometry_verified'] = False
                accepted['planning_evidence']['ranking_score'] = record['ranking_score']
                cells = geometry_cells(accepted['geometry']['coordinates'], latitude)
                valid.append((accepted, record, cells))
            ratios = [r['actual_distance_m'] / r['estimated_distance_m'] for r in measurements
                      if r.get('actual_distance_m', 0) > 0 and r.get('estimated_distance_m', 0) > 0]
            ratio = max(1, min(3, median(ratios))) if ratios else None
            if len(select_diverse(valid)) >= 3 and not (mountain and include_ascent):
                break
    selected = select_diverse(valid)
    diagnostics = {'schema_version': 'route_search.v1', 'evaluation_count': len(measurements),
                   'request_count': budget.count, 'request_count_scope': 'routing_and_elevation', 'elapsed_seconds': round(clock()-started, 3),
                   'observed_distance_ratio': ratio, 'distance_tolerance_ratio': .20, 'ascent_evaluation_count': ascent_evaluations,
                   'measurements': measurements, 'corridor_evidence': 'ordered_control_points_only'}
    if not selected:
        if failures and not any('actual_distance_m' in r for r in measurements):
            raise RouteProviderFailed(failures)
        error = RouteCandidateRejected('当前材料与两轮算路预算内未找到距离在目标 ±20% 内且满足约束的路线；原路线保持不变。',
                                       code='route_search_exhausted', stage='route_validation')
        error.search_diagnostics = diagnostics
        raise error
    candidates = []
    for index, (candidate, _, _) in enumerate(selected, 1):
        if include_elevation:
            candidate = validate(candidate, constraints, include_elevation=True, config=cfg)
        candidate['candidate_id'] = f'candidate_{index}'
        if len(selected) < 3:
            candidate.setdefault('warnings', []).append(f'本轮仅找到 {len(selected)} 条满足距离与差异要求的候选。')
        if any(c.get('preference_weight', 0) for c in materials.get('corridors', [])):
            candidate.setdefault('warnings', []).append('沿线偏好按连续控制点规划，尚未验证沿河或山路的实际覆盖长度。')
        candidates.append(candidate)
    return {'schema_version': 'route_plan.v1', 'plan_id': f'route_{uuid4().hex}',
            'workspace_id': workspace_id, 'revision': 0, 'title': title, 'day_count': 1,
            'schedule_type': 'single_day', 'country_code': materials['country_code'],
            'active_candidate_id': candidates[0]['candidate_id'], 'candidates': candidates,
            'route_constraints': constraints, 'route_preferences': preferences,
            'rejected_candidates': [{'name': f'评估候选 {i}', 'reason': r.get('message') or '地图算路失败',
                                     'code': r['status'], 'stage': 'route_validation'}
                                    for i, r in enumerate(measurements, 1) if r['status'] != 'accepted'],
            'route_search': diagnostics}


def select_diverse(valid):
    selected = []
    for item in sorted(valid, key=lambda v: (v[1].get('ranking_score', v[1]['distance_error_ratio']), -float(v[1].get('preferred_score', 0)),
                                            -v[1]['selected_route_retention'])):
        if any(similarity(item[2], other[2]) >= .88 for other in selected):
            continue
        selected.append(item)
        if len(selected) == 3:
            break
    return selected
