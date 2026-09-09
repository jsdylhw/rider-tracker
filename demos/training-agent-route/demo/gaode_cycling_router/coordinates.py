"""Small WGS-84 <-> GCJ-02 conversion helpers for the AMap boundary.

Route data in this repository (FIT, OSM and Strava) is WGS-84.  AMap's
mainland-China services and JS base map use GCJ-02, so conversion belongs at
the provider boundary rather than in source route files.
"""

from __future__ import annotations

import math
from collections.abc import Iterable


_A = 6378245.0
_EE = 0.00669342162296594323


def _outside_china(lon: float, lat: float) -> bool:
    return not (72.004 <= lon <= 137.8347 and 0.8293 <= lat <= 55.8271)


def _latitude_delta(lon: float, lat: float) -> float:
    value = -100.0 + 2.0 * lon + 3.0 * lat + 0.2 * lat * lat + 0.1 * lon * lat + 0.2 * math.sqrt(abs(lon))
    value += (20.0 * math.sin(6.0 * lon * math.pi) + 20.0 * math.sin(2.0 * lon * math.pi)) * 2.0 / 3.0
    value += (20.0 * math.sin(lat * math.pi) + 40.0 * math.sin(lat / 3.0 * math.pi)) * 2.0 / 3.0
    return value + (160.0 * math.sin(lat / 12.0 * math.pi) + 320.0 * math.sin(lat * math.pi / 30.0)) * 2.0 / 3.0


def _longitude_delta(lon: float, lat: float) -> float:
    value = 300.0 + lon + 2.0 * lat + 0.1 * lon * lon + 0.1 * lon * lat + 0.1 * math.sqrt(abs(lon))
    value += (20.0 * math.sin(6.0 * lon * math.pi) + 20.0 * math.sin(2.0 * lon * math.pi)) * 2.0 / 3.0
    value += (20.0 * math.sin(lon * math.pi) + 40.0 * math.sin(lon / 3.0 * math.pi)) * 2.0 / 3.0
    return value + (150.0 * math.sin(lon / 12.0 * math.pi) + 300.0 * math.sin(lon / 30.0 * math.pi)) * 2.0 / 3.0


def wgs84_to_gcj02(lon: float, lat: float) -> tuple[float, float]:
    """Convert a WGS-84 longitude/latitude pair to GCJ-02.

    Coordinates outside mainland China are returned unchanged; AMap's domestic
    riding API is not a replacement for global routing.
    """
    if _outside_china(lon, lat):
        return lon, lat
    delta_lat = _latitude_delta(lon - 105.0, lat - 35.0)
    delta_lon = _longitude_delta(lon - 105.0, lat - 35.0)
    radians = lat / 180.0 * math.pi
    magic = 1.0 - _EE * math.sin(radians) ** 2
    sqrt_magic = math.sqrt(magic)
    delta_lat = delta_lat * 180.0 / ((_A * (1.0 - _EE)) / (magic * sqrt_magic) * math.pi)
    delta_lon = delta_lon * 180.0 / (_A / sqrt_magic * math.cos(radians) * math.pi)
    return lon + delta_lon, lat + delta_lat


def gcj02_to_wgs84(lon: float, lat: float) -> tuple[float, float]:
    """Numerically invert :func:`wgs84_to_gcj02` to a useful display precision."""
    if _outside_china(lon, lat):
        return lon, lat
    guess_lon, guess_lat = lon, lat
    for _ in range(8):
        converted_lon, converted_lat = wgs84_to_gcj02(guess_lon, guess_lat)
        guess_lon -= converted_lon - lon
        guess_lat -= converted_lat - lat
    return guess_lon, guess_lat


def wgs84_line_to_gcj02(points: Iterable[tuple[float, float]]) -> list[tuple[float, float]]:
    return [wgs84_to_gcj02(lon, lat) for lon, lat in points]
