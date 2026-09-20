"""Bounded, provider-independent search of control-point route skeletons.

Distances are geometric estimates, and corridor coverage describes control
points only. Neither value establishes road distance or actual traversability.
"""
from collections import defaultdict
from functools import lru_cache

from services.route.geometry import haversine_m


def rank_skeletons(materials, points, segments=(), *, limit=24,
                   estimated_target_m=None, seed_point_ids=None):
    """Keep several length bands and corridor themes instead of one top-k list.

Search moves insert a point or an intact, directed corridor block. Required
points need not follow input-array order; only ordered_point_ids imposes order.
Optional Strava evidence is deliberately not interpreted as routable geometry.
"""
    if limit <= 0:
        return []
    origin = materials["origin_id"]
    end = origin if materials["is_loop"] else materials["destination_id"]
    corridors = materials.get("corridors", [])
    target = estimated_target_m or (materials.get("target_distance_km") or 0) * 1000
    required = frozenset(p["id"] for p in materials["points"] if p.get("required")) | {origin, end}
    ordered = materials.get("ordered_point_ids") or []
    seeds = frozenset(seed_point_ids or []) - {origin, end}
    coordinates = {pid: value["coordinate"] for pid, value in points.items()}
    distances = {(a, b): haversine_m(coordinates[a], coordinates[b])
                 for a in coordinates for b in coordinates}

    blocks = {(p["id"],) for p in materials["points"] if p["id"] not in {origin, end}}
    for corridor in corridors:
        sequence = corridor["point_ids"]
        choices = [sequence] if corridor.get("required") or not corridor.get("allow_partial", True) else [
            sequence[a:b] for a in range(len(sequence) - 1) for b in range(a + 2, len(sequence) + 1)]
        for sequence in choices:
            middle = tuple(p for p in sequence if p not in {origin, end})
            if middle:
                blocks.add(middle)
    blocks = sorted(blocks)

    def run_length(full, sequence):
        """Number of consecutive directed corridor edges present in one run."""
        best = 0
        for start, pid in enumerate(full):
            for offset, expected in enumerate(sequence):
                if pid != expected:
                    continue
                size = 0
                while start + size < len(full) and offset + size < len(sequence) and full[start + size] == sequence[offset + size]:
                    size += 1
                best = max(best, size - 1)
        return best

    @lru_cache(maxsize=20000)
    def metrics(ids):
        full = (origin, *ids, end)
        distance = sum(distances[a, b] for a, b in zip(full, full[1:]))
        coverage = {c["id"]: run_length(full, c["point_ids"]) / max(1, len(c["point_ids"]) - 1)
                    for c in corridors}
        preference = sum((float(c.get("preference_weight", c.get("weight", 1))) +
                          3 * bool(set(c.get("scenery", [])) & set(materials.get("scenery_preferences", [])))) * (
                             coverage[c["id"]] if c.get("allow_partial", True) else int(coverage[c["id"]] == 1))
                         for c in corridors if not c.get("required"))
        retention = len(seeds.intersection(ids)) / max(1, len(seeds))
        # No target means no distance-fit objective; meters must not drown out scenery.
        error = abs(distance - target) / target if target else 0
        return distance, coverage, preference, error - .15 * preference - .04 * retention

    def valid(ids):
        full = (origin, *ids, end)
        if len(full) > 12 or len(ids) != len(set(ids)) or origin in ids or end in ids:
            return False
        present = [pid for pid in full if pid in ordered]
        expected = [pid for pid in ordered if pid in full]
        if materials["is_loop"] and ordered and origin in ordered:
            present = present[:-1]
        return present == expected

    def complete(ids):
        full = {origin, *ids, end}
        return required <= full and all(not c.get("required") or metrics(ids)[1][c["id"]] == 1
                                       for c in corridors)

    def bucket(ids):
        distance, coverage, _, _ = metrics(ids)
        # Retain useful shorter estimates for subsequent real-distance feedback.
        band = min(8, int(distance / target / .15)) if target else len(ids)
        eligible = {c["id"]: coverage[c["id"]] for c in corridors
                    if c.get("allow_partial", True) or coverage[c["id"]] == 1}
        theme = max(eligible, key=lambda key: (eligible[key], key)) if any(eligible.values()) else ""
        missing = len(required - {origin, *ids, end})
        return band, theme, missing

    def diverse_pool(values, count):
        groups = defaultdict(list)
        for ids in sorted(values, key=lambda item: (metrics(item)[3], item)):
            groups[bucket(ids)].append(ids)
        # Round-robin across bins; each retains its best scoring route first.
        ranked = sorted(groups.values(), key=lambda group: (metrics(group[0])[3], group[0]))
        result = []
        for index in range(count):
            for group in ranked:
                if index < len(group):
                    result.append(group[index])
                    if len(result) == count:
                        return result
        return result

    beam = {tuple(): tuple()}
    finished = set()
    if seed_point_ids:
        seed = tuple(pid for pid in seed_point_ids if pid not in {origin, end} and pid in points)
        if valid(seed) and complete(seed):
            finished.add(seed)
    for _ in range(10):
        expanded = {}
        for ids, chunks in beam.items():
            for block in blocks:
                if set(block).intersection(ids):
                    continue
                # Insert only at block boundaries, preserving selected corridors.
                for index in range(len(chunks) + 1):
                    new_chunks = (*chunks[:index], block, *chunks[index:])
                    candidate = tuple(pid for chunk in new_chunks for pid in chunk)
                    if valid(candidate):
                        # Prefer the representation retaining the larger blocks
                        # when independent insertions produced identical IDs.
                        prior = expanded.get(candidate)
                        if prior is None or len(new_chunks) < len(prior):
                            expanded[candidate] = new_chunks
        if not expanded:
            break
        chosen = diverse_pool(expanded, 64)
        beam = {ids: expanded[ids] for ids in chosen}
        finished.update(ids for ids in chosen if complete(ids))
    if not materials["is_loop"] and complete(tuple()):
        finished.add(tuple())

    # Canonicalize reverse skeletons without reversing a returned directed route.
    unique = {}
    for ids in sorted(finished, key=lambda item: (metrics(item)[3], item)):
        key = min(ids, ids[::-1]) if materials["is_loop"] else ids
        unique.setdefault(key, ids)
    result = []
    for ids in diverse_pool(unique.values(), limit):
        full = [origin, *ids, end]
        distance, coverage, preference, _ = metrics(ids)
        result.append({
            "skeleton_id": f"s{len(result) + 1}", "point_ids": full,
            "legs": [{"kind": "connector", "from": coordinates[a], "to": coordinates[b]}
                     for a, b in zip(full, full[1:])],
            "estimated_distance_m": round(distance, 1),
            "score": abs(distance - target) if target else distance,
            "distance_kind": "geometry_plus_straight_connectors", "validation_status": "pending",
            "corridor_ids": [key for key, value in coverage.items() if value == 1],
            "preferred_score": round(preference, 4),
            "control_corridor_coverage": coverage,
        })
    return result
