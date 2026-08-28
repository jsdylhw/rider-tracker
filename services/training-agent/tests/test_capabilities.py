from services.capabilities import build_backend_capabilities


def test_backend_remains_available_without_llm_configuration():
    result = build_backend_capabilities({"agent": {"enabled": "auto"}})

    assert result["backend"] == "available"
    assert result["llm"] == "not_configured"
    assert result["capabilities"]["fit_ingestion"] is True
    assert result["capabilities"]["strava"] is True
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
    assert result["capabilities"]["ai_route_planning"] is True
