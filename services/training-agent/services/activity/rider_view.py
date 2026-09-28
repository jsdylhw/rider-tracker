"""Browser activity projection from the canonical FIT artifact."""
from __future__ import annotations

import math
from typing import Any


def _map(value):
    return value if isinstance(value, dict) else {}


def _first(*values):
    return next((value for value in values if value is not None), None)


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def canonical_detail_to_rider_activity(detail: dict, fallback: dict | None = None) -> dict[str, Any]:
    fallback = fallback or {}
    activity, metrics = _map(detail.get('activity')), _map(detail.get('metrics'))
    raw = _map(fallback.get('rawSession'))
    scale, power = _map(metrics.get('scale')), _map(metrics.get('power'))
    hr, cadence = _map(metrics.get('heart_rate')), _map(metrics.get('cadence'))
    performance = _map(metrics.get('performance'))
    energy = _map(_map(_map(raw.get('summary')).get('metrics')).get('energy'))
    tss = _map(_map(metrics.get('load')).get('power_stress')).get('tss')
    records, previous, ascent = [], None, 0
    fields = {'elapsedSeconds': 'elapsed_seconds', 'distanceKm': 'distance_km',
              'power': 'power_w', 'heartRate': 'heart_rate_bpm', 'cadence': 'cadence_rpm',
              'speedKph': 'speed_kmh', 'elevationMeters': 'elevation_m', 'gradePercent': 'grade_percent',
              'positionLat': 'latitude', 'positionLong': 'longitude'}
    for row in _map(detail.get('series')).get('records', []):
        elevation = row.get('elevation_m')
        if _finite(elevation):
            if _finite(previous):
                ascent += max(0, elevation - previous)
            previous = elevation
        record = {target: row.get(source) for target, source in fields.items()}
        record.update(elapsedSeconds=_first(row.get('elapsed_seconds'), 0),
                      distanceKm=_first(row.get('distance_km'), 0), ascentMeters=ascent)
        records.append(record)
    points = [{'latitude': r['positionLat'], 'longitude': r['positionLong'],
               'elevationMeters': r['elevationMeters'], 'distanceMeters': r['distanceKm'] * 1000}
              for r in records if _finite(r['positionLat']) and _finite(r['positionLong'])]
    route = _map(raw.get('route'))
    geometry = route.get('mapGeometry') or []
    if len(geometry) < 2:
        geometry = route.get('points') or []
    if sum(_finite(_first(p.get('latitude'), p.get('lat'))) and
           _finite(_first(p.get('longitude'), p.get('lng'))) for p in geometry if isinstance(p, dict)) < 2:
        route = {'source': 'fit-import', 'points': points, 'mapGeometry': points,
                 'totalDistanceMeters': (scale.get('distance_km') or 0) * 1000,
                 'totalElevationGainMeters': scale.get('total_ascent_m') or 0,
                 'hasElevationData': any(_finite(r['elevationMeters']) for r in records)}
    summary = {
        'ride': {'elapsedSeconds': scale.get('duration_s') or 0, 'distanceKm': scale.get('distance_km') or 0,
                 'ascentMeters': scale.get('total_ascent_m') or 0},
        'speed': {'averageKph': performance.get('avg_speed_kmh') or 0, 'maxKph': performance.get('max_speed_kmh') or 0},
        'power': {'averageWatts': power.get('avg_power_w') or 0, 'maxWatts': power.get('max_power_w') or 0,
                  'normalizedPowerWatts': power.get('normalized_power_w'), 'intensityFactor': power.get('intensity_factor'),
                  'variabilityIndex': power.get('variability_index')},
        'heartRate': {'averageBpm': hr.get('avg_hr_bpm') or 0, 'maxBpm': hr.get('max_hr_bpm') or 0},
        'cadence': {'averageRpm': cadence.get('avg') or 0, 'maxRpm': cadence.get('max') or 0},
        'load': {'estimatedTss': tss},
        'energy': {**energy, 'estimatedCaloriesKcal': _first(scale.get('calories'), energy.get('estimatedCaloriesKcal')),
                   'mechanicalWorkKj': _first(power.get('total_work_kj'), energy.get('mechanicalWorkKj')),
                   'method': 'fit' if scale.get('calories') is not None else energy.get('method')},
    }
    result = dict(fallback)
    mapping = {'id': 'activity_key', 'name': 'name', 'source': 'source', 'sportType': 'sport_type',
               'subSport': 'sub_sport', 'startedAt': 'start_time_local', 'fitFilePath': 'fit_path'}
    for target, source in mapping.items():
        result[target] = _first(activity.get(source), fallback.get(target))
    result['name'] = _first(result['name'], activity.get('file_name'), result['id'])
    for target, value in {'elapsedSeconds': scale.get('duration_s'), 'distanceKm': scale.get('distance_km'),
                          'ascentMeters': scale.get('total_ascent_m'), 'averagePower': power.get('avg_power_w'),
                          'normalizedPower': power.get('normalized_power_w'), 'averageHr': hr.get('avg_hr_bpm'),
                          'estimatedTss': tss}.items():
        result[target] = _first(value, fallback.get(target))
    settings = dict(_map(raw.get('settings')))
    for target, source in {'ftp': 'ftp', 'restingHr': 'resting_hr', 'maxHr': 'max_hr', 'mass': 'mass_kg'}.items():
        settings[target] = _first(_map(detail.get('settings')).get(source), settings.get(target))
    result['analysisReport'] = detail.get('report', fallback.get('analysisReport'))
    result['rawSession'] = {**raw, 'activityId': result['id'], 'createdAt': result['startedAt'],
                            'startedAt': result['startedAt'], 'source': result['source'] or 'fit-import',
                            'settings': settings, 'records': records, 'route': route, 'summary': {'metrics': summary},
                            'exportMetadata': {**_map(raw.get('exportMetadata')), 'activityName': result['name']}}
    return result
