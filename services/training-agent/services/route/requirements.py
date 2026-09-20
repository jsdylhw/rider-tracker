"""Merge explicit route edits and map selected-route seeds without interpreting prose.

Materials entering and leaving this module must be validated by the caller with
the union of current research sources and trusted previous material sources.
"""
from copy import deepcopy
import unicodedata

from services.route.materials import MaterialInputError


CHANGES_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "mode": {"type": "string", "enum": ["merge", "replace"],
                 "description": "默认 merge 保留未修改要求；明确换城市/国家才使用 replace。"},
        "fields": {"type": "array", "uniqueItems": True, "items": {
            "type": "string", "enum": ["origin", "destination", "target_distance_km",
                "locality", "locality_scope", "is_loop", "required_points", "ordered_point_ids", "corridors", "scenery_preferences"]},
            "description": "用户本轮明确修改的要求；未列出的要求从原计划继承。"},
    },
}


def _query(value):
    # Identity only: do not invent geographic aliases or fuzzy-match locations.
    return unicodedata.normalize("NFKC", str(value)).strip().casefold()


def merge_material_requirements(new, previous, changes=None):
    """Retain undeclared requirements while allowing new optional material.

    Point and corridor IDs are local to a material set, so inherited references
    are remapped by query, never by an ID that the model might have reused.
    Replacing all materials is an explicit operation, not inferred from text.
    """
    from jsonschema import Draft202012Validator
    changes = {} if changes is None else changes
    errors = list(Draft202012Validator(CHANGES_SCHEMA).iter_errors(changes))
    if errors:
        raise MaterialInputError(f"changes: {errors[0].message}")
    result = deepcopy(new)
    if not previous or changes.get("mode") == "replace":
        return result
    fields = set(changes.get("fields", []))
    if result["country_code"] != previous["country_code"]:
        raise MaterialInputError("更换国家须显式声明 changes.mode=replace")
    if "locality" in fields and _query(result.get("locality", "")) != _query(previous.get("locality", "")):
        raise MaterialInputError("更换城市须显式声明 changes.mode=replace")

    previous_points = {p["id"]: p for p in previous["points"]}
    points = result["points"]
    mapped = {}

    def inherit_point(old_id):
        if old_id in mapped:
            return mapped[old_id]
        old_point = previous_points[old_id]
        same = next((p for p in points if _query(p["query"]) == _query(old_point["query"])), None)
        if same is None:
            same = deepcopy(old_point)
            existing_ids = {p["id"] for p in points}
            index = 1
            while same["id"] in existing_ids:
                same["id"] = f"retained_{index}"
                index += 1
            points.append(same)
        mapped[old_id] = same["id"]
        return same["id"]

    for field in ("target_distance_km", "locality", "locality_scope", "is_loop"):
        if field not in fields:
            if field in previous:
                result[field] = deepcopy(previous[field])
            elif field == "locality_scope" and previous.get("locality"):
                # Older artifacts used locality as a hard city boundary.
                result[field] = "city"
            else:
                result.pop(field, None)
    for field, edit in (("distance_mode", "target_distance_km"), ("scenery_preferences", "scenery_preferences")):
        if edit not in fields:
            if field in previous:
                result[field] = deepcopy(previous[field])
            else:
                result.pop(field, None)
    if "origin" not in fields:
        result["origin_id"] = inherit_point(previous["origin_id"])
    if result["is_loop"]:
        # Changing the origin of a loop must also move its closure.
        result.pop("destination_id", None)
    elif "destination" not in fields and not previous["is_loop"]:
        result["destination_id"] = inherit_point(previous["destination_id"])

    if "required_points" not in fields:
        for point in previous["points"]:
            # Endpoints are governed by their own explicit edit fields.
            if point["required"] and point["id"] not in {previous["origin_id"], previous.get("destination_id")}:
                pid = inherit_point(point["id"])
                next(p for p in points if p["id"] == pid)["required"] = True
    if "ordered_point_ids" not in fields:
        if "ordered_point_ids" in previous:
            result["ordered_point_ids"] = [inherit_point(pid) for pid in previous["ordered_point_ids"]]
        else:
            result.pop("ordered_point_ids", None)
    if "corridors" not in fields:
        corridors = result.setdefault("corridors", [])
        for old in previous.get("corridors", []):
            inherited = deepcopy(old)
            inherited["point_ids"] = [inherit_point(pid) for pid in old["point_ids"]]
            index = next((i for i, c in enumerate(corridors) if _query(c["name"]) == _query(old["name"])), None)
            other_ids = {c["id"] for i, c in enumerate(corridors) if i != index}
            serial = 1
            while inherited["id"] in other_ids:
                inherited["id"] = f"retained_corridor_{serial}"
                serial += 1
            if index is None:
                corridors.append(inherited)
            else:
                corridors[index] = inherited
    return result


def normalize_planning_requirements(materials):
    """Apply defaults once, after edit merging; preserve explicit no-target modes."""
    result = deepcopy(materials)
    target = result.get("target_distance_km")
    mode = result.get("distance_mode") or ("target" if target is not None else "default")
    if mode in {"unrestricted", "route_length"}:
        if target is not None:
            raise MaterialInputError("不限距离/按起终点实际距离不能同时设置数字目标")
    elif mode == "default":
        if target is not None and target != 30:
            raise MaterialInputError("缺省距离为 30km；用户指定数字请用 distance_mode=target")
        result["target_distance_km"] = 30
    elif target is None:
        raise MaterialInputError("distance_mode=target 必须提供 target_distance_km")
    result["distance_mode"] = mode
    result.setdefault("scenery_preferences", [])
    return result


def selected_route_seed(queries, materials):
    """Return mapped control points, retaining a loop closure but no placeholders."""
    by_query = {_query(p["query"]): p["id"] for p in materials["points"]}
    seed = []
    for query in queries:
        pid = by_query.get(_query(query))
        if pid is not None and (not seed or pid != seed[-1]):
            seed.append(pid)
    return seed
