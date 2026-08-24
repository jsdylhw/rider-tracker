"""Static Web UI regressions for authenticated API calls and Strava completion."""

from __future__ import annotations

from pathlib import Path


WEB_ROOT = Path(__file__).resolve().parents[1] / "app" / "static"


def test_web_ui_keeps_api_token_in_session_and_uses_it_for_every_fetch_helper_call():
    source = (WEB_ROOT / "app.js").read_text(encoding="utf-8")

    assert "sessionStorage.getItem(API_TOKEN_STORAGE_KEY)" in source
    assert '"X-API-Token": token' in source
    assert "headers: apiHeaders(headers)" in source
    assert "fetchJson(`/api/summary?activity_key=${encodeURIComponent(file.activity_key)}`)" in source


def test_web_ui_waits_for_strava_completion_before_showing_success():
    source = (WEB_ROOT / "app.js").read_text(encoding="utf-8")

    assert "wait: true" in source
    assert "wait: false" not in source
    assert "uploadStatus.activity_id" in source
    assert "uploadStatus.error" in source
    assert "刷新确认" not in source


def test_web_ui_chat_reuses_session_and_sends_idempotency_key():
    source = (WEB_ROOT / "app.js").read_text(encoding="utf-8")
    markup = (WEB_ROOT / "index.html").read_text(encoding="utf-8")

    assert 'fetchJson("/api/chat"' in source
    assert "session_id: state.chatSessionId" in source
    assert 'request_id: randomId("request")' in source
    assert "sessionStorage.getItem(CHAT_SESSION_STORAGE_KEY)" in source
    assert 'id="chatForm"' in markup
    assert 'id="presentations"' in markup


def test_web_ui_renders_presentations_without_injecting_markdown_html():
    source = (WEB_ROOT / "app.js").read_text(encoding="utf-8")

    assert 'block.type === "metric_cards"' in source
    assert 'block.type === "table"' in source
    assert 'block.type === "line_chart"' in source
    assert 'block.type === "markdown"' in source
    assert 'markdown.textContent = block.data?.markdown || ""' in source
    assert "createElementNS(namespace, \"svg\")" in source
    assert 'summary.className = "chart-summary"' in source
    assert 'grid.setAttribute("class", "chart-grid")' in source
    assert 'label.setAttribute("class", "chart-value-label")' in source
    assert "if (values.length <= 40)" in source
    assert 'createElementNS(namespace, "path")' in source


def test_web_ui_initializes_leaflet_view_before_adding_route_layers():
    source = (WEB_ROOT / "app.js").read_text(encoding="utf-8")

    initialize = 'L.map(container, { zoomControl: true }).setView([0, 0], 2)'
    add_route = "L.geoJSON(route.geometry"
    fit_route = "map.fitBounds("
    assert initialize in source
    assert source.index(initialize) < source.index(add_route) < source.index(fit_route)


def test_route_leaflet_labels_are_bound_as_text_nodes():
    source = (WEB_ROOT / "app.js").read_text(encoding="utf-8")

    assert "bindPopup(leafletText(" in source
    assert "bindTooltip(leafletText(" in source
    assert 'content.textContent = String(value ?? "")' in source


def test_route_map_switches_one_candidate_at_a_time_and_persists_preview():
    source = (WEB_ROOT / "app.js").read_text(encoding="utf-8")

    assert 'button.className = "route-map-choice"' in source
    assert 'const candidateRoutes = routes.filter((route) => route.kind !== "strava_segment")' in source
    assert "candidateRoutes[selectedCandidateIndex]" in source
    assert 'fetchJson("/api/route-plans/select"' in source
    assert "candidate_id: route.candidate_id" in source
    assert "json: {" in source
    assert "body: JSON.stringify({\n                session_id: state.chatSessionId" not in source


def test_chat_and_presentations_scroll_independently_on_desktop():
    styles = (WEB_ROOT / "styles.css").read_text(encoding="utf-8")

    assert "height: clamp(520px, calc(100vh - 220px), 760px);" in styles
    assert "max-height: 760px;" in styles
    assert ".presentation-column {\n  overflow: auto;\n}" in styles
    assert ".chat-messages {\n  min-height: 0;\n  overflow: auto;" in styles
    assert ".conversation-column {" in styles
    assert "overflow: hidden;" in styles


def test_web_ui_versions_local_static_assets_to_avoid_stale_layout_cache():
    markup = (WEB_ROOT / "index.html").read_text(encoding="utf-8")

    assert 'href="/static/styles.css?v=' in markup
    assert 'src="/static/app.js?v=' in markup


def test_strava_route_map_supports_ordered_multi_selection_and_agent_composition():
    source = (WEB_ROOT / "app.js").read_text(encoding="utf-8")

    assert 'const segmentRoutes = routes.filter((route) => route.kind === "strava_segment")' in source
    assert "const selectedSegmentIndexes = []" in source
    assert "selectedSegmentIndexes.length < 3" in source
    assert 'composeButton.textContent = "用所选路段生成路线"' in source
    assert "选择顺序就是骑行顺序" in source
    assert "请按这个顺序使用当前路线已发现的 Strava 路段生成新候选" in source
    assert "visibleRoutes.push({ route: candidateRoutes[selectedCandidateIndex]" in source


def test_web_ui_uses_full_width_with_more_space_for_presentations():
    styles = (WEB_ROOT / "styles.css").read_text(encoding="utf-8")

    assert ".shell {\n  width: 100%;\n  max-width: none;" in styles
    assert "grid-template-columns: minmax(300px, 0.75fr) minmax(480px, 1.25fr);" in styles
