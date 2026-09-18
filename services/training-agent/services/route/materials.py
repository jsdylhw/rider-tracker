"""Versioned, provider-independent input for route preparation (not a route)."""
from copy import deepcopy
import math


MATERIALS_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["country_code", "origin_id", "is_loop", "points"],
    "properties": {
        "schema_version": {"const": "route_materials.v1", "type": "string"},
        "country_code": {"type": "string", "pattern": "^[A-Z]{2}$"},
        "locality": {"type": "string", "minLength": 1, "maxLength": 100, "description": "用户限定的城市，如京都市；不可替换为京都府。无城市限制可省略。"},
        "origin_id": {"type": "string"}, "destination_id": {"type": "string"},
        "is_loop": {"type": "boolean"},
        "target_distance_km": {"type": "number", "minimum": 1, "maximum": 500},
        "points": {"type": "array", "minItems": 2, "maxItems": 12, "items": {
            "type": "object", "additionalProperties": False,
            "required": ["id", "query", "required", "source_ids"],
            "properties": {
                "id": {"type": "string", "minLength": 1, "maxLength": 80},
                "query": {"type": "string", "minLength": 1, "maxLength": 300},
                "required": {"type": "boolean"},
                "source_ids": {"type": "array", "maxItems": 10, "items": {"type": "string"}},
            },
        }},
        "corridors": {"type": "array", "maxItems": 6, "items": {
            "type": "object", "additionalProperties": False,
            "required": ["id", "name", "point_ids", "required", "source_ids"],
            "properties": {
                "id": {"type": "string", "minLength": 1, "maxLength": 80},
                "name": {"type": "string", "minLength": 1, "maxLength": 300},
                "point_ids": {"type": "array", "minItems": 2, "maxItems": 12,
                              "items": {"type": "string"}},
                "required": {"type": "boolean"},
                "source_ids": {"type": "array", "maxItems": 10, "items": {"type": "string"}},
            },
        }},
    },
}


def validate_materials(value, *, source_ids=()):
    # Keep tool and service validation identical, including rejecting model GPS.
    from jsonschema import Draft202012Validator
    errors = sorted(Draft202012Validator(MATERIALS_SCHEMA).iter_errors(value), key=lambda e: str(e.path))
    if errors:
        raise MaterialInputError(f"{errors[0].json_path}: {errors[0].message}")
    result = deepcopy(value)
    result["schema_version"] = "route_materials.v1"
    for point in result["points"]:
        point["query"] = point["query"].strip()
    points = {p["id"]: p for p in result["points"]}
    identities = {}
    for point in result["points"]:
        if point["id"] in identities and identities[point["id"]] != point["query"]:
            raise MaterialInputError("points.id: 同一 ID 不能表示不同地点")
        identities[point["id"]] = point["query"]
    aliases, canonical, queries = {}, {}, {}
    for point in result["points"]:
        query = point["query"]
        if query in queries:
            existing = canonical[queries[query]]
            existing["required"] |= point["required"]
            existing["source_ids"] = list(dict.fromkeys(existing["source_ids"] + point["source_ids"]))
            aliases[point["id"]] = existing["id"]
        else:
            queries[query] = point["id"]
            canonical[point["id"]] = point
            aliases[point["id"]] = point["id"]
    result["points"] = list(canonical.values())
    points = canonical
    if len(points) < 2:
        raise MaterialInputError("points: 至少需要两个不同地点")
    for key in ("origin_id", "destination_id"):
        if key in result:
            result[key] = aliases.get(result[key], result[key])
    for corridor in result.get("corridors", []):
        ids = [aliases.get(pid, pid) for pid in corridor["point_ids"]]
        # Only the trailing origin is a closure marker. Never erase an internal revisit.
        if result["is_loop"] and len(ids) > 2 and ids[0] == ids[-1] == result["origin_id"]:
            ids.pop()
        if len(set(ids)) != len(ids):
            raise MaterialInputError("corridors.point_ids: 暂不支持线路中间重复经过地点；请拆成不同走廊，不要删除折返点")
        corridor["point_ids"] = ids
    if result["origin_id"] not in points:
        raise MaterialInputError("origin_id must reference a point")
    destination = result.get("destination_id")
    if result["is_loop"]:
        if destination and destination != result["origin_id"]:
            raise MaterialInputError("loop destination must equal origin")
    elif destination not in points or destination == result["origin_id"]:
        raise MaterialInputError("open route requires a distinct destination_id")
    target = result.get("target_distance_km")
    if target is not None and not math.isfinite(target):
        raise MaterialInputError("target distance must be finite")
    corridors = result.setdefault("corridors", [])
    if len({c["id"] for c in corridors}) != len(corridors):
        raise MaterialInputError("corridor IDs must be unique")
    for corridor in corridors:
        if not set(corridor["point_ids"]) <= points.keys():
            raise MaterialInputError("corridor references unknown points")
    known = set(source_ids)
    for item in [*result["points"], *corridors]:
        if not set(item["source_ids"]) <= known:
            raise MaterialInputError("material references unknown research sources")
        if not str(item.get("query", item.get("name", ""))).strip():
            raise MaterialInputError("material name/query must not be blank")
    return result


class MaterialInputError(ValueError):
    """Pre-I/O input failure, with a separate bounded correction budget."""

    def to_tool_result(self):
        return {"status": "failed", "error": "route_materials_invalid", "code": "route_materials_invalid",
                "stage": "material_validation", "retryable": True,
                "message": str(self), "hint": "重新提交完整 materials；地点按 query 唯一，is_loop 表达闭合，schema_version 可省略。"}
