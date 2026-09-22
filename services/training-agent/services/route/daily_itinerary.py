"""One cycling itinerary, independently persisted daily route artifacts.

The existing candidate IDs address selectable daily artifacts, not alternative
itineraries. itinerary_schema_version makes that interpretation explicit.
"""
from copy import deepcopy
from math import isfinite
from uuid import uuid4

from services.route.single_day import route_candidate
from services.route.provider_readiness import use_amap_routes
from services.route.quality import normalize_route_constraints, normalize_route_preferences
from settings import load_config
from storage.repositories.route import RouteRevisionConflict

VERSION = 'cycling_itinerary.v1'


def is_daily(plan):
    return plan.get('itinerary_schema_version') == VERSION


def _range(value):
    if value is None:
        return None
    if not isinstance(value, list) or len(value) != 2:
        raise ValueError('每日距离范围需要 [最少公里, 最多公里]')
    if any(isinstance(x, bool) or not isinstance(x, (int, float)) or not isfinite(x) for x in value):
        raise ValueError('每日距离必须是有限数字')
    if not 0 < value[0] <= value[1]:
        raise ValueError('每日距离范围必须为正数且下限不大于上限')
    return list(value)


def normalize_day(spec, index):
    points = spec.get('waypoints')
    if not isinstance(points, list) or not 2 <= len(points) <= 12 or any(not isinstance(p, str) or not p.strip() for p in points):
        raise ValueError('每天必须提供 2–12 个明确起终点/途经点')
    target = spec.get('target_distance_km')
    bounds = _range(spec.get('distance_range_km'))
    if target is not None:
        if isinstance(target, bool) or not isinstance(target, (int, float)) or not isfinite(target) or target <= 0:
            raise ValueError('每日目标距离必须为有限正数')
        if bounds and not bounds[0] <= target <= bounds[1]:
            raise ValueError('每日目标距离须位于距离范围内')
    return {'candidate_id': f'day_{index}', 'day': index,
            'name': str(spec.get('label') or f'第 {index} 天'),
            'waypoint_queries': [p.strip() for p in points],
            'target_distance_km': target, 'distance_range_km': bounds,
            'day_status': 'pending', 'warnings': [], 'travel_mode': 'BICYCLE',
            'day_revision': 0,
            'route_constraints': normalize_route_constraints(spec.get('route_constraints')),
            'route_preferences': normalize_route_preferences(spec.get('route_preferences'))}


def draft_itinerary(*, workspace_id, title, country_code, candidates):
    if len(candidates) != 1:
        raise ValueError('多日骑行第一版只支持一套行程方案')
    specs = candidates[0].get('stages') or []
    if not 2 <= len(specs) <= 7:
        raise ValueError('多日骑行需要 2–7 天')
    days = []
    for index, spec in enumerate(specs, 1):
        if spec.get('day') != index or spec.get('period', 'full_day') != 'full_day':
            raise ValueError('多日草案每天一条路线，天数从 1 连续排列')
        days.append(normalize_day(spec, index))
    if not str(country_code).strip():
        raise ValueError('需要国家代码')
    plan = {'schema_version': 'route_plan.v1', 'itinerary_schema_version': VERSION,
            'plan_id': f'route_{uuid4().hex}', 'workspace_id': workspace_id,
            'title': title or '多日骑行行程', 'country_code': country_code.upper(),
            'schedule_type': 'multi_day', 'day_count': len(days), 'revision': 0,
            'active_candidate_id': days[0]['candidate_id'], 'candidates': days}
    check_connections(plan)
    return plan


def check_connections(plan):
    days = plan['candidates']
    for day in days:
        day['connection_warning'] = None
    for previous, day in zip(days, days[1:]):
        if previous['waypoint_queries'][-1] != day['waypoint_queries'][0]:
            day['connection_warning'] = '前一天终点与当天起点不同，请确认衔接。'
        elif previous.get('day_status') == day.get('day_status') == 'ready':
            from services.route.geometry import haversine_m
            if haversine_m(previous['geometry']['coordinates'][-1], day['geometry']['coordinates'][0]) > 5000:
                day['connection_warning'] = '地图解析的跨日起终点相距超过 5 km，请修改后重新生成。'


def update_day(store, plan, *, operation, candidate_id, expected_revision, args, include_elevation=False):
    if expected_revision is None or plan['revision'] != expected_revision:
        raise RouteRevisionConflict(plan_id=plan['plan_id'], expected=expected_revision or 0, actual=plan['revision'])
    unsupported = {'stage_id', 'stage_label', 'waypoint_index', 'new_waypoint', 'segments', 'segment_preferences'} & args.keys()
    if args.get('segment_strategy') not in (None, 'ignore'):
        unsupported.add('segment_strategy')
    if operation == 'generate_day':
        unsupported |= {'waypoints', 'candidate_name', 'target_distance_km', 'distance_range_km'} & args.keys()
    unsupported = {key for key in unsupported if args[key] not in (None, '', [])}
    if unsupported:
        raise ValueError('当前逐日操作不支持这些参数，请先用 edit_day 修改当天：' + ', '.join(sorted(unsupported)))
    result = deepcopy(plan)
    day = next((d for d in result['candidates'] if d['candidate_id'] == candidate_id), None)
    if day is None:
        raise ValueError('请选择行程中的一天')
    result['active_candidate_id'] = candidate_id
    old = deepcopy(day)
    for field, normalize in (('route_constraints', normalize_route_constraints), ('route_preferences', normalize_route_preferences)):
        raw = args.get(field, {})
        if not isinstance(raw, dict) or set(raw) - set(normalize({})):
            raise ValueError(f'不支持的每日参数：{field}')
        day[field] = normalize({**day.get(field, {}), **raw})
    if operation == 'edit_day':
        spec = {'label': args.get('candidate_name') or day['name'],
                'waypoints': args.get('waypoints', day['waypoint_queries']),
                'target_distance_km': args.get('target_distance_km', day.get('target_distance_km')),
                'distance_range_km': args.get('distance_range_km', day.get('distance_range_km')),
                'route_constraints': day['route_constraints'], 'route_preferences': day['route_preferences']}
        normalized = normalize_day(spec, old['day'])
        route_changed = (
            normalized['waypoint_queries'] != old['waypoint_queries']
            or normalized['route_constraints'] != normalize_route_constraints(old.get('route_constraints'))
            or normalized['route_preferences'] != normalize_route_preferences(old.get('route_preferences'))
        )
        distance_changed = any(normalized[key] != old.get(key) for key in ('target_distance_km', 'distance_range_km'))
        if route_changed:
            backup = successful_snapshot(old)
            day.clear(); day.update(normalized)
            if backup:
                day['last_successful_route'] = backup
            day['day_revision'] = (old.get('day_revision') or 0) + 1
            day['day_status'] = 'needs_regeneration'
            invalidate_confirmation(result, day)
        else:
            for key in ('name', 'target_distance_km', 'distance_range_km', 'route_constraints', 'route_preferences'):
                day[key] = normalized[key]
            if distance_changed:
                day['day_revision'] = (old.get('day_revision') or 0) + 1
                invalidate_confirmation(result, day)
                if day.get('day_status') == 'ready':
                    update_distance_assessment(day)
        check_connections(result)
        return store.save(result, expected_revision=expected_revision)
    if operation != 'generate_day':
        raise ValueError('不支持的逐日操作')
    backup = successful_snapshot(old)
    # Keep requirements separate from the previous measured artifact.
    fields = ('candidate_id', 'day', 'name', 'day_revision', 'waypoint_queries',
              'target_distance_km', 'distance_range_km', 'route_constraints', 'route_preferences')
    pending = {key: deepcopy(day.get(key)) for key in fields}
    day.clear(); day.update(pending)
    day['warnings'] = []
    if backup:
        day['last_successful_route'] = backup
    day['day_status'] = 'generating'
    day.pop('error', None)
    day.pop('failure', None)
    invalidate_confirmation(result, day)
    day['day_revision'] = (day.get('day_revision') or 0) + 1
    running = store.save(result, expected_revision=expected_revision)
    # Save the in-flight version before network I/O. Only its owner may finish it.
    result = deepcopy(running)
    day = next(d for d in result['candidates'] if d['candidate_id'] == candidate_id)
    try:
        config = load_config()
        if (not use_amap_routes(plan['country_code'], config)
                and day['route_preferences'] != normalize_route_preferences({})):
            raise ValueError('当前 Google 逐日路线暂不支持导航偏好排序；请取消该偏好后重试。')
        routed = route_candidate({'candidate_id': candidate_id, 'name': day['name'],
                                  'waypoints': day['waypoint_queries'],
                                  'target_distance_km': day.get('target_distance_km') or (day.get('distance_range_km') or [None, None])[1]},
                                 index=day['day'], country_code=plan['country_code'],
                                 include_elevation=include_elevation, config=config, allow_distance_mismatch=True,
                                 route_constraints=day['route_constraints'], route_preferences=day['route_preferences'])
        # Keep requirements independent from the numerical search target.
        preserved = {k: day.get(k) for k in ('day', 'day_revision', 'waypoint_queries', 'target_distance_km', 'distance_range_km', 'route_constraints', 'route_preferences')}
        day.clear(); day.update(routed); day.update(preserved)
        day['day_status'] = 'ready'
        update_distance_assessment(day)
        result['active_candidate_id'] = candidate_id
    except (RuntimeError, ValueError) as exc:
        day['day_status'] = 'failed'
        day['error'] = str(exc)
        day['failure'] = exc.to_failure() if hasattr(exc, 'to_failure') else {
            'message': str(exc), 'code': getattr(exc, 'code', 'route_day_failed'),
            'stage': getattr(exc, 'stage', 'route_calculation'), 'provider': getattr(exc, 'provider', None),
            'retryable': getattr(exc, 'retryable', False)}
        day.pop('geometry', None)
    check_connections(result)
    return store.save(result, expected_revision=running['revision'], archive=False)


def itinerary_answer(plan):
    rows = [f"{plan['title']}：共 {len(plan['candidates'])} 天骑行。"]
    labels = {'pending': '待生成', 'generating': '生成中', 'ready': '已生成', 'failed': '生成失败', 'needs_regeneration': '待重新生成'}
    for day in plan['candidates']:
        actual = f"；地图里程 {float(day.get('distance_m') or float(day.get('distance_km') or 0)*1000)/1000:.1f} km，{duration_label(day)} {float(day.get('duration_s') or float(day.get('duration_min') or 0)*60)/3600:.1f} 小时" if day['day_status'] == 'ready' else ('；可预览上次成功路线，尚未完成本次生成' if day.get('last_successful_route') or day.get('has_previous_route') else '；尚无可用地图里程和时间')
        rows.append(f"第 {day['day']} 天：{' → '.join(day['waypoint_queries'])}；{labels[day['day_status']]}{actual}" + (f"；{day['error']}" if day.get('error') else '') + ('；' + '；'.join(day.get('warnings') or []) if day.get('warnings') else '') + (f"；{day['connection_warning']}" if day.get('connection_warning') else ''))
    rows.append('可按天生成或修改；草案不代表已完成算路。跨天重复路段尚未自动优化。')
    return '\n'.join(rows)


def duration_label(day):
    return {'BICYCLE': '预计骑行', 'DRIVE': '地图驾车时间（虚拟观景路径）'}.get(day.get('travel_mode'), '地图行程时间')


def invalidate_confirmation(plan, day):
    day.pop('confirmation', None)
    if (plan.get('planning') or {}).get('confirmed_candidate_id') == day['candidate_id']:
        plan.pop('planning', None)


def operation_result(plan, candidate_id, *, failed=False):
    return {'schema_version': 'route_operation.v1', 'plan_id': plan['plan_id'],
            'revision': plan['revision'], 'candidate_id': candidate_id,
            'status': 'failed' if failed else 'completed'}


def successful_snapshot(day):
    if day.get('day_status') == 'ready' and day.get('geometry'):
        return {'schema_version': 'route_day_snapshot.v1',
                'route': {key: deepcopy(value) for key, value in day.items()
                          if key not in ('last_successful_route', 'confirmation', 'connection_warning')}}
    return deepcopy(day.get('last_successful_route'))


def update_distance_assessment(day):
    # Keep provider warnings separate so changing distance bounds removes obsolete warnings.
    base = day.get('provider_warnings')
    if base is None:
        base = [w for w in day.get('warnings', []) if not (w.startswith('实际 ') and '每日' in w)]
    day['provider_warnings'] = list(base)
    day['warnings'] = list(base)
    bounds = day.get('distance_range_km')
    actual = day['distance_m'] / 1000
    day['distance_satisfied'] = None
    if bounds:
        day['distance_satisfied'] = bounds[0] <= actual <= bounds[1]
        if not day['distance_satisfied']:
            day['warnings'].append(f'实际 {actual:.1f} km，未达到每日 {bounds[0]}–{bounds[1]} km 要求。')
    elif day.get('target_distance_km'):
        from services.route.distance import target_distance_error
        error = target_distance_error(day['distance_m'], day['target_distance_km'])
        day['distance_satisfied'] = not bool(error)
        if error:
            day['warnings'].append(str(error))
