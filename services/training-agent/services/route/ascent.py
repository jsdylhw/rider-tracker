"""Optional, non-physical Google ascent preview for validated candidates."""
from copy import deepcopy
import math
import hashlib
import json


def ascent_view(candidate):
    value = candidate.get("ascent_preview") or {}
    ascent = value.get("ascent_m")
    if not isinstance(ascent, (int, float)) or isinstance(ascent, bool) or not math.isfinite(ascent) or ascent < 0:
        return None
    return {"schema_version": "route_ascent.v1", "provider": "google_elevation",
            "ascent_m": round(ascent), "estimated": True, "simulation_usable": False}


def enrich_ascent_preview(plan, *, config=None):
    from services.route.single_day import _elevation_profile
    from settings import load_config
    result = deepcopy(plan)
    cfg = config if config is not None else load_config()
    for candidate in result.get("candidates", [])[:3]:
        if not (candidate.get("geometry") or {}).get("coordinates") or not candidate.get("distance_m"):
            # Multi-stage/legacy artifacts need their own sampling geometry.
            candidate.setdefault("warnings", []).append("当前路线缺少完整采样几何，暂不提供估算爬升。")
            continue
        digest = hashlib.sha256(json.dumps([candidate.get("geometry"), candidate.get("distance_m")],
                                          sort_keys=True).encode()).hexdigest()
        if (candidate.get("ascent_preview") or {}).get("geometry_digest") == digest and ascent_view(candidate):
            continue
        if candidate.get("ascent_unavailable_digest") == digest:
            continue
        candidate.pop("ascent_unavailable_digest", None)
        candidate.pop("ascent_preview", None)
        try:
            elevation = _elevation_profile(candidate["geometry"]["coordinates"], candidate["distance_m"], cfg)
            candidate["ascent_preview"] = ascent_view({"ascent_preview": elevation.get("summary")})
            if candidate["ascent_preview"] is not None:
                candidate["ascent_preview"]["geometry_digest"] = digest
            candidate.setdefault("warnings", []).append("Google 估算爬升仅供观景参考，不代表最大坡度；虚拟骑行仍按平坡运行。")
        except (RuntimeError, ValueError) as exc:
            candidate["ascent_unavailable_digest"] = digest
            candidate.setdefault("warnings", []).append(f"估算爬升暂不可用：{exc}；不影响路线预览。")
    return result
