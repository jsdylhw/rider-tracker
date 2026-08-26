"""Project trusted tool outputs into small, stable UI presentation blocks."""

from __future__ import annotations

from typing import Any

from agent.runtime.models import ToolExecution
from agent.runtime.presentations import PresentationBlock
from services.activity.presentation import build_activity_profile


def project_presentations(executions: list[ToolExecution]) -> list[PresentationBlock]:
    """Return deterministic UI blocks for the tool schemas understood by the UI."""
    blocks: list[PresentationBlock] = []
    has_detailed_single_activity = any(
        _result_kind(_schema_payload(execution.result)) == "activity_report"
        or (
            execution.tool == "inspect_selection"
            and _result_kind(_schema_payload(execution.result)) == "analysis_result"
        )
        for execution in executions
    )
    for execution in executions:
        payload = _schema_payload(execution.result)
        result_kind = _result_kind(payload)
        if result_kind == "training_history_analysis":
            blocks.extend(_training_history_blocks(execution, payload))
        elif result_kind == "activity_report":
            blocks.extend(_activity_report_blocks(execution, payload))
        elif result_kind == "analysis_result":
            blocks.extend(_inspection_blocks(execution, payload))
        elif result_kind == "activity_comparison":
            blocks.extend(_activity_comparison_blocks(execution, payload))
        elif result_kind == "route_plan":
            blocks.extend(_route_plan_blocks(execution, payload))
        elif result_kind == "route_segment_discovery":
            blocks.extend(_route_segment_blocks(execution, payload))
        elif (
            result_kind == "activity_selection"
            and execution.tool == "resolve_activities"
            and not has_detailed_single_activity
        ):
            blocks.extend(_resolved_activity_blocks(execution, payload))
    return blocks


_LEGACY_RESULT_KINDS = {
    "training_history_analysis.v1": "training_history_analysis",
    "activity_report.v1": "activity_report",
    "analysis_result.v1": "analysis_result",
    "activity_comparison.v1": "activity_comparison",
    "route_plan.v1": "route_plan",
    "route_segment_discovery.v1": "route_segment_discovery",
    "activity_selection.v2": "activity_selection",
}


def _result_kind(payload: dict[str, Any]) -> str:
    """Use an internal discriminator while accepting old logged payloads."""
    kind = str(payload.get("kind") or "")
    if kind:
        return kind
    return _LEGACY_RESULT_KINDS.get(str(payload.get("schema_version") or ""), "")


def _route_plan_blocks(
    execution: ToolExecution,
    payload: dict[str, Any],
) -> list[PresentationBlock]:
    from storage.repositories.route import RoutePlanStore

    plan = RoutePlanStore().get(str(payload.get("plan_id") or ""))
    if not plan:
        return []
    candidates = [item for item in plan.get("candidates") or [] if isinstance(item, dict)]
    active_id = str(plan.get("active_candidate_id") or "")
    source = _source(execution, payload)
    blocks: list[PresentationBlock] = []
    pool_blocks = _route_pool_blocks(execution, plan, source)
    pool_routes = [
        route
        for block in pool_blocks if block.type == "route_map"
        for route in block.data.get("routes") or [] if isinstance(route, dict)
    ]
    has_stages = any(isinstance(item.get("stages"), list) for item in candidates)
    rows = []
    for item in candidates:
        segments = [stage for stage in item.get("stages") or [] if isinstance(stage, dict)] or [item]
        for segment in segments:
            rows.append({
                "candidate": item.get("name"),
                "stage": segment.get("label") if segment is not item else None,
                "waypoints": " → ".join(
                    str(point.get("name") or point.get("query") or "")
                    for point in segment.get("waypoints") or [] if isinstance(point, dict)
                ),
                "distance_km": segment.get("distance_km"),
                "duration_min": segment.get("duration_min"),
                "handoff_km": segment.get("handoff_from_previous_km") if segment is not item else None,
                "provider": segment.get("provider"),
                "mode": segment.get("travel_mode"),
                "kind": item.get("candidate_kind") or "baseline",
                "strava_segments": " + ".join(
                    str(value.get("name") or value.get("segment_id") or "")
                    for value in segment.get("strava_segments") or [] if isinstance(value, dict)
                ),
                "active": item.get("candidate_id") == active_id,
                "confirmed": item.get("candidate_id") == (
                    (plan.get("planning") or {}).get("confirmed_candidate_id")
                    if isinstance(plan.get("planning"), dict) else None
                ),
            })
    if rows:
        blocks.append(PresentationBlock(
            presentation_id=f"execution-{execution.index}-route-candidates",
            type="table",
            title=str(plan.get("title") or "路线候选"),
            data={
                "columns": (
                    ["candidate", "stage", "waypoints", "distance_km", "duration_min", "handoff_km", "provider", "mode", "kind", "strava_segments", "active", "confirmed"]
                    if has_stages
                    else ["candidate", "waypoints", "distance_km", "duration_min", "provider", "mode", "kind", "strava_segments", "active", "confirmed"]
                ),
                "rows": rows,
            },
            source=source,
        ))
    routes = []
    for item in candidates:
        segments = [stage for stage in item.get("stages") or [] if isinstance(stage, dict)] or [item]
        for segment in segments:
            geometry = segment.get("geometry") if isinstance(segment.get("geometry"), dict) else {}
            coordinates = geometry.get("coordinates") if isinstance(geometry.get("coordinates"), list) else []
            if len(coordinates) < 2:
                continue
            routes.append({
                "candidate_id": item.get("candidate_id"),
                "parent_candidate_id": item.get("parent_candidate_id"),
                "stage_id": segment.get("stage_id"),
                "kind": "planned_route",
                "name": (
                    f"{item.get('name')} · {segment.get('label')}"
                    if segment is not item else item.get("name")
                ),
                "active": item.get("candidate_id") == active_id,
                "geometry": {"type": "LineString", "coordinates": _bounded_coordinates(coordinates)},
                "waypoints": [
                    {
                        "name": point.get("name") or point.get("query"),
                        "latitude": point.get("display_latitude", point.get("latitude")),
                        "longitude": point.get("display_longitude", point.get("longitude")),
                    }
                    for point in segment.get("waypoints") or [] if isinstance(point, dict)
                ],
            })
    routes.extend(pool_routes)
    if routes:
        blocks.append(PresentationBlock(
            presentation_id=f"execution-{execution.index}-route-map",
            type="route_map",
            title="路线与 Strava 路段",
            data={
                "plan_id": plan.get("plan_id"),
                "country_code": plan.get("country_code"),
                "planning_status": (
                    (plan.get("planning") or {}).get("status")
                    if isinstance(plan.get("planning"), dict) else None
                ),
                "routes": routes,
            },
            source=source,
        ))
    active = next((item for item in candidates if item.get("candidate_id") == active_id), None)
    segments = (
        [stage for stage in active.get("stages") or [] if isinstance(stage, dict)]
        if isinstance(active, dict) and isinstance(active.get("stages"), list)
        else [active] if isinstance(active, dict) else []
    )
    for segment_index, segment in enumerate(segments):
        elevation = segment.get("elevation") if isinstance(segment.get("elevation"), dict) else {}
        labels = elevation.get("labels") if isinstance(elevation.get("labels"), list) else []
        values = elevation.get("elevations_m") if isinstance(elevation.get("elevations_m"), list) else []
        if labels and values:
            blocks.append(PresentationBlock(
                presentation_id=f"execution-{execution.index}-route-elevation-{segment_index}",
                type="line_chart",
                title=(
                    f"{segment.get('label')}参考海拔"
                    if segment.get("label") else "参考海拔剖面"
                ),
                data={
                    "x_label": "距离 (km)",
                    "labels": labels,
                    "series": [{"metric": "elevation_m", "unit": "m", "values": values}],
                },
                source=source,
            ))
    blocks.extend(block for block in pool_blocks if block.type != "route_map")
    return blocks


def _route_pool_blocks(
    execution: ToolExecution,
    plan: dict[str, Any],
    source: dict[str, Any],
) -> list[PresentationBlock]:
    pools = plan.get("segment_pool") if isinstance(plan.get("segment_pool"), dict) else {}
    segments: dict[int, dict[str, Any]] = {}
    for target_id, values in pools.items():
        for segment in values if isinstance(values, list) else []:
            if not isinstance(segment, dict):
                continue
            try:
                segment_id = int(segment.get("segment_id"))
            except (TypeError, ValueError):
                continue
            if segment_id not in segments:
                segments[segment_id] = {**segment, "candidate_ids": []}
            candidate_ids = segments[segment_id]["candidate_ids"]
            if str(target_id) not in candidate_ids:
                candidate_ids.append(str(target_id))
    if not segments:
        return []
    rows = []
    routes = []
    for segment_id, segment in segments.items():
        rows.append({
            "segment_id": segment_id,
            "segment_name": segment.get("name"),
            "distance_km": segment.get("distance_km"),
            "average_grade_percent": segment.get("average_grade_percent"),
            "elevation_difference_m": segment.get("elevation_difference_m"),
            "distance_to_route_km": segment.get("distance_to_route_km"),
            "route_overlap_ratio": segment.get("route_overlap_ratio"),
            "candidate_ids": segment.get("candidate_ids") or [],
        })
        geometry = segment.get("geometry") if isinstance(segment.get("geometry"), dict) else {}
        coordinates = geometry.get("coordinates") if isinstance(geometry.get("coordinates"), list) else []
        if len(coordinates) >= 2:
            routes.append({
                "segment_id": segment_id,
                "candidate_ids": segment.get("candidate_ids") or [],
                "name": f"Strava · {segment.get('name') or segment_id}",
                "kind": "strava_segment",
                "active": False,
                "geometry": {"type": "LineString", "coordinates": _bounded_coordinates(coordinates)},
                "waypoints": [],
            })
    blocks = [PresentationBlock(
        presentation_id=f"execution-{execution.index}-route-pool",
        type="table",
        title="可选 Strava 热门路段",
        data={
            "columns": [
                "segment_id", "segment_name", "distance_km", "average_grade_percent",
                "elevation_difference_m", "distance_to_route_km", "route_overlap_ratio",
                "candidate_ids",
            ],
            "rows": rows,
        },
        source=source,
    )]
    if routes:
        blocks.append(PresentationBlock(
            presentation_id=f"execution-{execution.index}-route-pool-map",
            type="route_map",
            title="Strava 路段地图",
            data={
                "plan_id": plan.get("plan_id"),
                "routes": routes,
            },
            source=source,
        ))
    return blocks


def _route_segment_blocks(
    execution: ToolExecution,
    payload: dict[str, Any],
) -> list[PresentationBlock]:
    from storage.repositories.route import RoutePlanStore

    plan = RoutePlanStore().get(str(payload.get("plan_id") or ""))
    if not plan:
        return []
    candidate_id = str(payload.get("candidate_id") or plan.get("active_candidate_id") or "")
    candidate = next(
        (
            item for item in plan.get("candidates") or []
            if isinstance(item, dict) and str(item.get("candidate_id") or "") == candidate_id
        ),
        None,
    )
    if not candidate:
        return []
    stage_id = str(payload.get("stage_id") or "")
    stages = [item for item in candidate.get("stages") or [] if isinstance(item, dict)]
    targets = stages or [candidate]
    if stage_id:
        targets = [item for item in targets if str(item.get("stage_id") or "") == stage_id]
    rows = []
    routes = []
    seen_segment_ids: set[int] = set()
    for target in targets:
        geometry = target.get("geometry") if isinstance(target.get("geometry"), dict) else {}
        coordinates = geometry.get("coordinates") if isinstance(geometry.get("coordinates"), list) else []
        target_label = str(target.get("label") or candidate.get("name") or "当前路线")
        if len(coordinates) >= 2:
            routes.append({
                "name": target_label,
                "kind": "planned_route",
                "active": True,
                "geometry": {"type": "LineString", "coordinates": _bounded_coordinates(coordinates)},
                "waypoints": [],
            })
        for segment in target.get("strava_segments") or []:
            if not isinstance(segment, dict):
                continue
            try:
                segment_id = int(segment.get("segment_id"))
            except (TypeError, ValueError):
                continue
            if segment_id in seen_segment_ids:
                continue
            seen_segment_ids.add(segment_id)
            rows.append({
                "stage": target_label if stages else None,
                "segment_name": segment.get("name"),
                "distance_km": segment.get("distance_km"),
                "average_grade_percent": segment.get("average_grade_percent"),
                "elevation_difference_m": segment.get("elevation_difference_m"),
                "climb_category": segment.get("climb_category"),
                "distance_to_route_km": segment.get("distance_to_route_km"),
                "route_overlap_ratio": segment.get("route_overlap_ratio"),
            })
            segment_geometry = segment.get("geometry") if isinstance(segment.get("geometry"), dict) else {}
            segment_coordinates = (
                segment_geometry.get("coordinates")
                if isinstance(segment_geometry.get("coordinates"), list) else []
            )
            if len(segment_coordinates) >= 2:
                routes.append({
                    "segment_id": segment_id,
                    "name": f"Strava · {segment.get('name') or segment_id}",
                    "kind": "strava_segment",
                    "active": False,
                    "geometry": {
                        "type": "LineString",
                        "coordinates": _bounded_coordinates(segment_coordinates),
                    },
                    "waypoints": [],
                })
    source = _source(execution, payload)
    blocks: list[PresentationBlock] = []
    if rows:
        columns = [
            "segment_name", "distance_km", "average_grade_percent",
            "elevation_difference_m", "climb_category", "distance_to_route_km",
            "route_overlap_ratio",
        ]
        if stages:
            columns.insert(0, "stage")
        blocks.append(PresentationBlock(
            presentation_id=f"execution-{execution.index}-route-segments",
            type="table",
            title="Strava 热门骑行路段",
            data={"columns": columns, "rows": rows},
            source=source,
        ))
    if routes:
        blocks.append(PresentationBlock(
            presentation_id=f"execution-{execution.index}-route-segment-map",
            type="route_map",
            title="计划路线与 Strava 路段",
            data={"plan_id": plan.get("plan_id"), "routes": routes},
            source=source,
        ))
    return blocks


def _bounded_coordinates(value: list[Any], *, limit: int = 800) -> list[Any]:
    if len(value) <= limit:
        return value
    step = (len(value) - 1) / (limit - 1)
    return [value[round(index * step)] for index in range(limit)]


def _schema_payload(result: Any) -> dict[str, Any]:
    if not isinstance(result, dict):
        return {}
    nested = result.get("result")
    if isinstance(nested, dict) and (nested.get("kind") or nested.get("schema_version")):
        return nested
    return result


def _training_history_blocks(
    execution: ToolExecution,
    payload: dict[str, Any],
) -> list[PresentationBlock]:
    source = _source(execution, payload)
    blocks = []
    summary = _training_history_summary(payload)
    if summary:
        blocks.append(PresentationBlock(
            presentation_id=f"execution-{execution.index}-history-summary",
            type="markdown",
            title="训练趋势总结",
            data={"markdown": summary},
            source=source,
        ))
    rows = _history_rows(payload.get("dimensions"))
    if rows:
        blocks.append(PresentationBlock(
            presentation_id=f"execution-{execution.index}-history-table",
            type="table",
            title="训练趋势对比",
            data={
                "columns": [
                    "dimension", "metric", "baseline", "current", "change", "unit", "confidence",
                ],
                "rows": rows,
            },
            source=source,
        ))

    chart = _history_chart(payload)
    if chart["series"]:
        blocks.append(PresentationBlock(
            presentation_id=f"execution-{execution.index}-history-chart",
            type="line_chart",
            title="训练周期趋势",
            data=chart,
            source=source,
        ))
    return blocks


def _training_history_summary(payload: dict[str, Any]) -> str:
    conclusion = payload.get("conclusion") if isinstance(payload.get("conclusion"), dict) else {}
    summary = str(conclusion.get("summary") or "").strip()
    confidence = _confidence_label(conclusion.get("confidence"))
    warnings = [
        str(value).strip()
        for value in payload.get("warnings") or []
        if str(value).strip()
    ]
    recommendation = str(payload.get("recommended_next_check") or "").strip()
    if not any((summary, confidence, warnings, recommendation)):
        return ""

    lines: list[str] = []
    if summary:
        lines.extend(["## 结论", summary])
    if confidence:
        lines.append(f"**可信度：** {confidence}")
    if warnings:
        lines.extend(["", "## 注意事项"])
        lines.extend(f"- {warning}" for warning in warnings)
    if recommendation:
        lines.extend(["", "## 下一步", recommendation])
    return "\n".join(lines).strip()


def _confidence_label(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    return {"low": "低", "medium": "中", "high": "高"}.get(normalized, normalized)


def _history_rows(value: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for dimension in value if isinstance(value, list) else []:
        if not isinstance(dimension, dict):
            continue
        evidence = dimension.get("evidence")
        evidence_items = evidence if isinstance(evidence, list) else []
        for item in evidence_items:
            if not isinstance(item, dict):
                continue
            if not item.get("metric"):
                continue
            rows.append({
                "dimension": dimension.get("name"),
                "metric": item.get("metric"),
                "baseline": item.get("baseline"),
                "current": item.get("current"),
                "change": item.get("percent_change"),
                "unit": item.get("unit"),
                "confidence": dimension.get("confidence"),
            })
    return rows


def _history_chart(payload: dict[str, Any]) -> dict[str, Any]:
    series_payload = payload.get("series") if isinstance(payload.get("series"), dict) else {}
    periods = series_payload.get("periods") if isinstance(series_payload.get("periods"), list) else []
    view = payload.get("view") if isinstance(payload.get("view"), dict) else {}
    metrics = view.get("chart_metrics") if isinstance(view.get("chart_metrics"), list) else []
    labels = [period.get("period") for period in periods if isinstance(period, dict)]
    series = []
    for metric in metrics:
        metric_name = str(metric)
        values = []
        has_value = False
        for period in periods:
            totals = period.get("totals") if isinstance(period, dict) else None
            value = totals.get(metric_name) if isinstance(totals, dict) else None
            values.append(value)
            has_value = has_value or value is not None
        if has_value:
            series.append({
                "metric": metric_name,
                "unit": _metric_unit(metric_name),
                "values": values,
            })
    return {"x_label": "训练周期", "labels": labels, "series": series}


def _activity_report_blocks(
    execution: ToolExecution,
    payload: dict[str, Any],
) -> list[PresentationBlock]:
    result = execution.result if isinstance(execution.result, dict) else {}
    blocks: list[PresentationBlock] = []
    fit_summary = payload.get("fit_summary") if isinstance(payload.get("fit_summary"), dict) else {}
    cards = _activity_metric_cards(fit_summary)
    if cards:
        blocks.append(PresentationBlock(
            presentation_id=f"execution-{execution.index}-activity-metrics",
            type="metric_cards",
            title="活动概览",
            data={"items": cards},
            source=_source(execution, payload),
        ))
    profile = build_activity_profile(payload.get("fit_path"))
    if profile.get("series"):
        blocks.append(PresentationBlock(
            presentation_id=f"execution-{execution.index}-activity-profile",
            type="line_chart",
            title="活动过程曲线",
            data=profile,
            source=_source(execution, payload),
        ))
    markdown = result.get("answer") or payload.get("markdown_report")
    if isinstance(markdown, str) and markdown.strip():
        blocks.append(PresentationBlock(
            presentation_id=f"execution-{execution.index}-activity-report",
            type="markdown",
            title="活动分析报告",
            data={"markdown": markdown},
            source=_source(execution, payload),
        ))
    return blocks


def _resolved_activity_blocks(
    execution: ToolExecution,
    payload: dict[str, Any],
) -> list[PresentationBlock]:
    activities = [item for item in payload.get("activities") or [] if isinstance(item, dict)]
    if len(activities) != 1:
        return []
    activity = activities[0]
    source = _source(execution, payload)
    blocks = []
    cards = _activity_metric_cards(activity)
    if activity.get("summary_label"):
        cards.insert(0, {"metric": "summary_label", "value": activity["summary_label"], "unit": ""})
    if cards:
        blocks.append(PresentationBlock(
            presentation_id=f"execution-{execution.index}-resolved-activity-metrics",
            type="metric_cards",
            title="活动概览",
            data={"items": cards},
            source=source,
        ))
    profile = build_activity_profile(activity.get("fit_path"))
    if profile.get("series"):
        blocks.append(PresentationBlock(
            presentation_id=f"execution-{execution.index}-resolved-activity-profile",
            type="line_chart",
            title="活动过程曲线",
            data=profile,
            source=source,
        ))
    return blocks


def _inspection_blocks(
    execution: ToolExecution,
    payload: dict[str, Any],
) -> list[PresentationBlock]:
    """Project a single deterministic inspection without parsing its answer."""
    if execution.tool != "inspect_selection":
        return []
    analysis = payload.get("analysis") if isinstance(payload.get("analysis"), dict) else {}
    metrics = analysis.get("metrics") if isinstance(analysis.get("metrics"), dict) else {}
    if metrics.get("schema_version") != "activity_metrics.v2":
        return []

    identity = metrics.get("identity") if isinstance(metrics.get("identity"), dict) else {}
    scale = metrics.get("scale") if isinstance(metrics.get("scale"), dict) else {}
    summary = {**identity, **scale}
    source = _source(execution, payload)
    blocks: list[PresentationBlock] = []
    cards = _activity_metric_cards(summary)
    if cards:
        blocks.append(PresentationBlock(
            presentation_id=f"execution-{execution.index}-inspection-metrics",
            type="metric_cards",
            title="活动概览",
            data={"items": cards},
            source=source,
        ))
    profile = build_activity_profile(metrics.get("fit_path"))
    if profile.get("series"):
        blocks.append(PresentationBlock(
            presentation_id=f"execution-{execution.index}-inspection-profile",
            type="line_chart",
            title="活动过程曲线",
            data=profile,
            source=source,
        ))
    return blocks


def _activity_comparison_blocks(
    execution: ToolExecution,
    payload: dict[str, Any],
) -> list[PresentationBlock]:
    activities = [item for item in payload.get("activities") or [] if isinstance(item, dict)]
    if not activities:
        return []
    source = _source(execution, payload)
    blocks: list[PresentationBlock] = []
    totals = payload.get("totals") if isinstance(payload.get("totals"), dict) else {}
    cards = [{"metric": "activity_count", "value": len(activities), "unit": "条"}]
    cards.extend(_activity_metric_cards(totals))
    blocks.append(PresentationBlock(
        presentation_id=f"execution-{execution.index}-comparison-totals",
        type="metric_cards",
        title="活动对比总览",
        data={"items": cards},
        source=source,
    ))

    candidate_columns = [
        "start_time_local", "summary_label", "sport_type", "duration_min", "distance_km",
        "tss", "intensity_factor", "main_stimulus", "load_label",
    ]
    columns = [
        column for column in candidate_columns
        if any(row.get(column) is not None and row.get(column) != "" for row in activities)
    ]
    rows = [{column: activity.get(column) for column in columns} for activity in activities]
    if columns:
        blocks.append(PresentationBlock(
            presentation_id=f"execution-{execution.index}-comparison-table",
            type="table",
            title="活动逐项对比",
            data={"columns": columns, "rows": rows},
            source=source,
        ))
    return blocks


def _activity_metric_cards(fit_summary: dict[str, Any]) -> list[dict[str, Any]]:
    cards = []
    duration_s = _number(fit_summary.get("duration_s"))
    distance_m = _number(fit_summary.get("distance_m"))
    duration_min = _number(fit_summary.get("duration_min"))
    distance_km = _number(fit_summary.get("distance_km"))
    if duration_min is None and duration_s is not None:
        duration_min = duration_s / 60
    if distance_km is None and distance_m is not None:
        distance_km = distance_m / 1000
    values = [
        ("sport_type", fit_summary.get("sport_type"), ""),
        ("start_time_local", fit_summary.get("start_time_local"), ""),
        ("duration_min", round(duration_min, 1) if duration_min is not None else None, "min"),
        ("distance_km", round(distance_km, 2) if distance_km is not None else None, "km"),
    ]
    for metric, value, unit in values:
        if value is not None and value != "":
            cards.append({"metric": metric, "value": value, "unit": unit})
    return cards


def _source(execution: ToolExecution, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "execution_index": execution.index,
        "tool": execution.tool,
        "result_kind": _result_kind(payload),
    }


def _metric_unit(metric: str) -> str:
    return {"duration_min": "min", "distance_km": "km", "tss": "TSS"}.get(metric, "")


def _number(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None
