"""Compatibility imports for the standalone AMap demo."""

from integrations.route_providers.coordinates import (
    gcj02_to_wgs84,
    wgs84_line_to_gcj02,
    wgs84_to_gcj02,
)

__all__ = ["gcj02_to_wgs84", "wgs84_line_to_gcj02", "wgs84_to_gcj02"]
