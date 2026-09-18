from copy import deepcopy

import pytest

from services.route.materials import MaterialInputError, validate_materials
from services.route.requirements import merge_material_requirements, selected_route_seed


def materials():
    return {"country_code": "JP", "locality": "京都市", "origin_id": "a", "is_loop": True,
            "target_distance_km": 30,
            "points": [{"id": pid, "query": query, "required": pid == "b", "source_ids": []}
                       for pid, query in [("a", "京都駅"), ("b", "鴨川入口"), ("c", "鴨川出口")]],
            "ordered_point_ids": ["b", "c"],
            "corridors": [{"id": "river", "name": "鴨川", "point_ids": ["b", "c"],
                           "required": False, "preference_weight": 4, "allow_partial": True, "source_ids": []}]}


def test_undeclared_edits_retain_requirements_and_remap_ids_without_mutation():
    previous = materials()
    new = {**materials(), "target_distance_km": 40, "locality": "京都府", "origin_id": "a",
           "ordered_point_ids": [], "corridors": [],
           "points": [{"id": "a", "query": "別の出発点", "required": False, "source_ids": []},
                      {"id": "x", "query": "鴨川入口", "required": False, "source_ids": []}]}
    before = deepcopy(new)
    result = validate_materials(merge_material_requirements(new, previous))
    assert new == before
    assert result["target_distance_km"] == 30
    assert result["locality"] == "京都市"
    by_id = {p["id"]: p for p in result["points"]}
    assert by_id[result["origin_id"]]["query"] == "京都駅"
    assert by_id["x"]["required"] is True
    assert result["ordered_point_ids"] == result["corridors"][0]["point_ids"]
    assert result["corridors"][0]["preference_weight"] == 4


def test_only_declared_distance_changes():
    new = materials()
    new.update(target_distance_km=40, locality="京都府")
    result = merge_material_requirements(new, materials(), {"fields": ["target_distance_km"]})
    assert result["target_distance_km"] == 40
    assert result["locality"] == "京都市"


def test_corridor_edit_can_remove_previous_preference_without_removing_required_point():
    new = materials()
    new["corridors"] = []
    new["points"][1]["required"] = False
    result = merge_material_requirements(new, materials(), {"fields": ["corridors"]})
    assert result["corridors"] == []
    assert result["points"][1]["required"] is True


@pytest.mark.parametrize("country,locality", [("FR", "Paris"), ("JP", "大阪市")])
def test_region_change_requires_explicit_replace(country, locality):
    new = {**materials(), "country_code": country, "locality": locality}
    with pytest.raises(MaterialInputError, match="replace"):
        merge_material_requirements(new, materials(), {"fields": ["locality"]})
    assert merge_material_requirements(new, materials(), {"mode": "replace"}) == new


def test_new_origin_does_not_retain_old_endpoint_as_mandatory_stop():
    previous = materials()
    previous["points"][0]["required"] = True
    new = materials()
    new["points"][0]["query"] = "新しい駅"
    result = validate_materials(merge_material_requirements(new, previous, {"fields": ["origin"]}))
    assert all(p["query"] != "京都駅" for p in result["points"])


def test_seed_maps_queries_not_reused_ids_and_keeps_closure():
    value = materials()
    value["points"][0]["id"] = "new_origin"
    assert selected_route_seed(["京都駅", "未知", "鴨川入口", "京都駅"], value) == ["new_origin", "b", "new_origin"]


def test_explicit_order_is_independent_of_required_and_checked_after_aliases():
    value = materials()
    assert validate_materials(value)["ordered_point_ids"] == ["b", "c"]
    value["ordered_point_ids"] = ["missing"]
    with pytest.raises(MaterialInputError, match="ordered_point_ids"):
        validate_materials(value)
    value["points"].append({**value["points"][1], "id": "alias"})
    value["ordered_point_ids"] = ["b", "alias"]
    with pytest.raises(MaterialInputError, match="ordered_point_ids"):
        validate_materials(value)


def test_legacy_v1_without_new_fields_still_validates():
    value = materials()
    del value["ordered_point_ids"]
    del value["corridors"][0]["preference_weight"]
    del value["corridors"][0]["allow_partial"]
    assert validate_materials(value)["schema_version"] == "route_materials.v1"


def test_unknown_edit_and_nonfinite_preference_are_rejected():
    with pytest.raises(MaterialInputError, match="changes"):
        merge_material_requirements(materials(), materials(), {"fields": ["anything"]})
    value = materials()
    value["corridors"][0]["preference_weight"] = float("nan")
    with pytest.raises(MaterialInputError, match="finite"):
        validate_materials(value)


def test_inherited_sources_must_still_be_trusted_by_caller():
    previous = materials()
    previous["corridors"][0]["source_ids"] = ["old_research"]
    result = merge_material_requirements(materials(), previous)
    with pytest.raises(MaterialInputError, match="unknown research"):
        validate_materials(result)
    assert validate_materials(result, source_ids=["old_research"])
