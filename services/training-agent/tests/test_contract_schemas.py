from domain.contracts.schemas import (
    AGENT_TURN_V1,
    PRESENTATION_V1,
    PUBLIC_SCHEMAS,
    PERSISTED_SCHEMAS,
    STABLE_SCHEMAS,
)


def test_stable_schema_registry_separates_public_and_persisted_contracts():
    assert AGENT_TURN_V1 in PUBLIC_SCHEMAS
    assert PRESENTATION_V1 in PUBLIC_SCHEMAS
    assert PUBLIC_SCHEMAS.isdisjoint(PERSISTED_SCHEMAS)
    assert STABLE_SCHEMAS == PUBLIC_SCHEMAS | PERSISTED_SCHEMAS
    assert all(value.endswith((".v1", ".v2")) for value in STABLE_SCHEMAS)
