from __future__ import annotations

from pathlib import Path
from unittest.mock import Mock

import pytest

from integrations.garmin import (
    GarminChinaDownloader,
    GarminServiceError,
    activity_base_name,
    existing_fit_paths,
    garmin_error_payload,
    safe_filename,
    save_original_as_fit,
)


class _Response:
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code


class _HttpFailure(Exception):
    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.response = _Response(status_code)


class GarminConnectAuthenticationError(Exception):
    pass


def test_safe_filename_removes_path_unsafe_characters():
    assert safe_filename('a/b:c*"x"\n') == "a_b_c_x_"


def test_activity_base_name_uses_local_start_name_and_id():
    activity = {
        "activityId": 123,
        "activityName": "青浦区 公路骑行",
        "startTimeLocal": "2026-05-18 08:36:17",
    }

    assert activity_base_name(activity) == "2026-05-18 08_36_17_青浦区 公路骑行_123"


def test_existing_fit_paths_matches_saved_activity_prefix(tmp_path):
    activity = {
        "activityId": 123,
        "activityName": "Ride",
        "startTimeLocal": "2026-05-18",
    }
    fit_path = tmp_path / "2026-05-18_Ride_123.fit"
    fit_path.write_bytes(b"fit")
    (tmp_path / "other.fit").write_bytes(b"fit")

    assert existing_fit_paths(tmp_path, activity) == [fit_path]


def test_save_original_writes_fit_atomically(tmp_path):
    activity = {"activityId": 123, "activityName": "Ride", "startTimeLocal": "2026-05-18"}

    paths = save_original_as_fit(b"complete-fit", tmp_path, activity)

    assert len(paths) == 1
    assert paths[0].read_bytes() == b"complete-fit"
    assert not list(tmp_path.glob("*.part"))


def test_social_profile_failure_is_retryable_and_not_reported_as_bad_credentials():
    network_error = OSError("SSL EOF while reading secret-token-value")
    wrapped = GarminConnectAuthenticationError("Failed to retrieve social profile")
    wrapped.__cause__ = network_error

    result = garmin_error_payload(wrapped, operation="login")

    assert result == {
        "error": "garmin_profile_unavailable",
        "message": "Garmin Connect 暂时无法读取账户资料，请稍后重试；本次未下载活动。",
        "retryable": True,
    }
    assert "secret-token-value" not in result["message"]


def test_explicit_unauthorized_failure_is_non_retryable_auth_error():
    cause = _HttpFailure("request rejected", 401)
    wrapped = GarminConnectAuthenticationError("Failed to retrieve social profile")
    wrapped.__cause__ = cause

    result = garmin_error_payload(wrapped, operation="login")

    assert result["error"] == "garmin_auth_failed"
    assert result["retryable"] is False
    assert "账号、密码或授权状态" in result["message"]


def test_rate_limit_failure_has_specific_retryable_message():
    result = garmin_error_payload(_HttpFailure("request rejected", 429), operation="login")

    assert result["error"] == "garmin_rate_limited"
    assert result["retryable"] is True
    assert "请求过于频繁" in result["message"]


@pytest.mark.parametrize("status,code", [(401, "garmin_auth_failed"), (429, "garmin_rate_limited")])
def test_library_text_status_is_preserved(status, code):
    wrapped = GarminConnectAuthenticationError("Failed to retrieve social profile")
    wrapped.__cause__ = RuntimeError(f"API Error {status} - rejected")
    assert garmin_error_payload(wrapped)["error"] == code


def _cached_failure(status):
    error = GarminConnectAuthenticationError("Failed to retrieve social profile")
    error.__cause__ = RuntimeError(f"API Error {status} - rejected")
    return error


def test_cached_401_recovers_and_persists_validated_tokens(tmp_path, monkeypatch):
    token = tmp_path / "garmin_tokens.json"
    token.write_bytes(b"old-token")
    old, fresh = Mock(), Mock()
    old.login.side_effect = _cached_failure(401)

    def dump(directory):
        (Path(directory) / "garmin_tokens.json").write_bytes(b"new-token")

    fresh.client.dump.side_effect = dump
    factory = Mock(side_effect=[old, fresh])
    monkeypatch.setattr("garminconnect.Garmin", factory)
    downloader = GarminChinaDownloader(username="user", password="password", tokenstore=tmp_path)
    downloader.login()
    assert downloader.client is fresh
    assert token.read_bytes() == b"new-token"
    assert [p.read_bytes() for p in tmp_path.glob("*.bak")] == [b"old-token"]
    assert fresh.client._tokenstore_path == str(token)
    temporary = Path(fresh.login.call_args.args[0])
    assert temporary != tmp_path
    assert not temporary.exists()
    assert factory.call_count == 2


def test_failed_fresh_login_preserves_cached_tokens(tmp_path, monkeypatch):
    token = tmp_path / "garmin_tokens.json"
    token.write_bytes(b"old-token")
    old, fresh = Mock(), Mock()
    old.login.side_effect = _cached_failure(401)
    fresh.login.side_effect = RuntimeError("API Error 401 - rejected")
    factory = Mock(side_effect=[old, fresh])
    monkeypatch.setattr("garminconnect.Garmin", factory)
    downloader = GarminChinaDownloader(username="user", password="password", tokenstore=tmp_path)
    with pytest.raises(GarminServiceError) as error:
        downloader.login()
    assert error.value.code == "garmin_auth_failed"
    assert token.read_bytes() == b"old-token"
    assert not list(tmp_path.glob("*.bak"))
    fresh.client.dump.assert_not_called()
    assert factory.call_count == 2


@pytest.mark.parametrize("status", [429, 503])
def test_other_profile_errors_do_not_trigger_fresh_login(tmp_path, monkeypatch, status):
    (tmp_path / "garmin_tokens.json").write_bytes(b"old-token")
    old = Mock()
    old.login.side_effect = _cached_failure(status)
    factory = Mock(return_value=old)
    monkeypatch.setattr("garminconnect.Garmin", factory)
    with pytest.raises(GarminServiceError):
        GarminChinaDownloader(username="user", password="password", tokenstore=tmp_path).login()
    assert factory.call_count == 1
