from services.capabilities import build_backend_capabilities


def test_backend_remains_available_without_llm_configuration():
    result = build_backend_capabilities({"agent": {"enabled": "auto"}})

    assert result["backend"] == "available"
    assert result["llm"] == "not_configured"
    assert result["capabilities"]["fit_ingestion"] is True
    assert result["capabilities"]["strava"] is False
    assert result["capabilities"]["activity_analysis"] is False
    assert result["capabilities"]["ai_route_planning"] is False


def test_explicit_agent_disable_wins_over_complete_configuration():
    result = build_backend_capabilities({
        "agent": {
            "enabled": False,
            "base_url": "https://llm.example.test",
            "api_key": "secret",
            "model": "model",
        }
    })

    assert result["llm"] == "disabled"
    assert result["capabilities"]["route_narration"] is False


def test_complete_auto_configuration_enables_llm_capabilities():
    result = build_backend_capabilities({
        "agent": {
            "enabled": "auto",
            "base_url": "https://llm.example.test",
            "api_key": "secret",
            "model": "model",
        }
    })

    assert result["llm"] == "ready"
    assert result["capabilities"]["training_history"] is True
    assert result["capabilities"]["activity_analysis"] is True
    assert result["capabilities"]["ai_route_planning"] is False


def test_online_route_capabilities_follow_google_and_amap_configuration():
    result = build_backend_capabilities({
        "agent": {
            "enabled": "auto",
            "base_url": "https://llm.example.test",
            "api_key": "secret",
            "model": "model",
        },
        "google": {"api_key": "google-key"},
        "amap": {"web_service_key": "amap-key"},
    })

    assert result["schema_version"] == "training_backend_capabilities.v2"
    assert result["providers"]["google"]["status"] == "ready"
    assert result["capabilities"]["domestic_ai_routes"] is True
    assert result["capabilities"]["international_ai_routes"] is True
    assert result["capabilities"]["route_narration"] is True


def test_amap_without_google_does_not_enable_online_route_experience():
    result = build_backend_capabilities({
        "agent": {
            "enabled": "auto",
            "base_url": "https://llm.example.test",
            "api_key": "secret",
            "model": "model",
        },
        "amap": {"web_service_key": "amap-key"},
    })

    assert result["providers"]["amap"]["status"] == "ready"
    assert result["capabilities"]["ai_route_planning"] is False
    assert result["capabilities"]["map_exploration"] is False
    assert result["capabilities"]["route_narration"] is False


def test_google_without_llm_enables_maps_but_not_agent_routes_or_narration():
    result = build_backend_capabilities({"google": {"api_key": "google-key"}})

    assert result["capabilities"]["map_waypoint_routes"] is True
    assert result["capabilities"]["map_exploration"] is True
    assert result["capabilities"]["street_view"] is True
    assert result["capabilities"]["google_elevation_reference"] is True
    assert result["capabilities"]["ai_route_planning"] is False
    assert result["capabilities"]["route_narration"] is False


def test_google_and_llm_enable_international_but_not_domestic_routes_without_amap():
    result = build_backend_capabilities({
        "agent": {
            "base_url": "https://llm.example.test",
            "api_key": "secret",
            "model": "model",
        },
        "google": {"api_key": "google-key"},
    })

    assert result["capabilities"]["ai_route_planning"] is True
    assert result["capabilities"]["international_ai_routes"] is True
    assert result["capabilities"]["domestic_ai_routes"] is False


def test_example_placeholders_do_not_enable_external_providers():
    result = build_backend_capabilities({
        "google": {"api_key": "replace-with-google-maps-api-key"},
        "amap": {"web_service_key": "replace-with-amap-web-service-key"},
        "strava": {
            "client_id": "your-strava-client-id",
            "client_secret": "your-strava-client-secret",
        },
        "garmin_username": "your-garmin-cn-email",
        "garmin_password": "your-garmin-cn-password",
    })

    assert result["providers"]["google"]["status"] == "missing"
    assert result["providers"]["amap"]["status"] == "missing"
    assert result["capabilities"]["strava"] is False
    assert result["capabilities"]["garmin_sync"] is False


def test_account_integrations_and_profile_are_reported_independently():
    result = build_backend_capabilities({
        "strava": {"client_id": "123", "client_secret": "secret"},
        "garmin_username": "rider@example.test",
        "garmin_password": "secret",
        "athlete": {"ftp": 250, "weight_kg": 75},
    })

    assert result["capabilities"]["strava"] is True
    assert result["capabilities"]["garmin_sync"] is True
    assert result["providers"]["athlete_profile"]["status"] == "partial"
