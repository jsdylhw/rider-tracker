from __future__ import annotations

from pathlib import Path

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



@pytest.fixture
def native_login(monkeypatch):
    """Exercise real Garmin.login; replace only network/storage boundary calls."""
    from types import SimpleNamespace
    from garminconnect.client import Client
    state = SimpleNamespace(status=None, stage="profile", fresh_rejected=False,
                            refresh_before_profile=False, logins=0, writes=[], clients=[])
    phases = {}

    def load(client, path):
        token = Path(path) / "garmin_tokens.json"
        if not token.is_file():
            raise FileNotFoundError()
        client._tokenstore_path = str(token)
        client.di_refresh_token = None
        phases[id(client)] = "cached"
        if state.refresh_before_profile:
            token.write_bytes(b"refreshed-before-validation")

    def login(client, *args, **kwargs):
        state.logins += 1
        phases[id(client)] = "fresh"
        return None, None

    def dump(client, path):
        token = Path(path)
        if token.is_dir():
            token /= "garmin_tokens.json"
        token.write_bytes(b"new-token")
        state.writes.append(token)

    def connectapi(client, path, **kwargs):
        state.clients.append(client)
        stage = "profile" if "socialProfile" in path else "settings"
        if stage == state.stage and state.status is not None:
            if phases.get(id(client)) == "cached" or state.fresh_rejected:
                if state.status == "timeout":
                    raise TimeoutError("timed out")
                raise RuntimeError(f"API Error {state.status} - rejected")
        return {"displayName": "test"} if stage == "profile" else {"userData": {"measurementSystem": "metric"}}

    monkeypatch.setattr(Client, "load", load)
    monkeypatch.setattr(Client, "login", login)
    monkeypatch.setattr(Client, "dump", dump)
    monkeypatch.setattr(Client, "connectapi", connectapi)
    monkeypatch.setattr(Client, "_token_expires_soon", lambda _: False)
    monkeypatch.setattr("garminconnect.time.sleep", lambda _: None)
    return state


@pytest.mark.parametrize("file_path", [False, True])
@pytest.mark.parametrize("cached", [False, True])
def test_login_validates_before_promoting_private_tokens(tmp_path, native_login, file_path, cached):
    import os
    import stat
    token = tmp_path / "garmin_tokens.json"
    if cached:
        token.write_bytes(b"old-token")
        token.chmod(0o600)
        native_login.status = 401
    downloader = GarminChinaDownloader(username="test", password="test", tokenstore=token if file_path else tmp_path)
    downloader.login()
    assert native_login.logins == 1
    assert token.read_bytes() == b"new-token"
    backups = list(tmp_path.glob("*.bak"))
    assert [p.read_bytes() for p in backups] == ([b"old-token"] if cached else [])
    assert downloader.client.client._tokenstore_path == str(token)
    assert all(p.parent != tmp_path and not p.exists() for p in native_login.writes)
    if os.name != "nt":
        assert stat.S_IMODE(token.stat().st_mode) == 0o600
        assert all(stat.S_IMODE(p.stat().st_mode) == 0o600 for p in backups)
    # Subsequent library writes go to the promoted store, not a deleted temp path.
    downloader.client.client.dump(downloader.client.client._tokenstore_path)
    assert native_login.writes[-1] == token


@pytest.mark.parametrize("stage", ["profile", "settings"])
@pytest.mark.parametrize("status,code", [(429, "garmin_rate_limited"), (503, None), ("timeout", None)])
def test_non_auth_failure_does_not_relogin_or_modify_cache(tmp_path, native_login, stage, status, code):
    token = tmp_path / "garmin_tokens.json"
    token.write_bytes(b"old-token")
    native_login.status, native_login.stage = status, stage
    native_login.refresh_before_profile = True
    downloader = GarminChinaDownloader(username="test", password="test", tokenstore=tmp_path)
    with pytest.raises(GarminServiceError) as failure:
        downloader.login()
    assert failure.value.code == (code or f"garmin_{stage}_unavailable")
    assert native_login.logins == 0
    assert token.read_bytes() == b"old-token"
    assert not list(tmp_path.glob("*.bak"))
    assert downloader.client is None


@pytest.mark.parametrize("stage", ["profile", "settings"])
def test_rejected_relogin_is_not_repeated_and_keeps_original(tmp_path, native_login, stage):
    token = tmp_path / "garmin_tokens.json"
    token.write_bytes(b"old-token")
    native_login.status, native_login.stage = 401, stage
    native_login.fresh_rejected = native_login.refresh_before_profile = True
    downloader = GarminChinaDownloader(username="test", password="test", tokenstore=tmp_path)
    with pytest.raises(GarminServiceError) as failure:
        downloader.login()
    assert failure.value.code == "garmin_auth_failed"
    assert native_login.logins == 1
    assert token.read_bytes() == b"old-token"
    assert downloader.client is None
    assert not list(tmp_path.glob("*.bak"))


def test_cached_login_needs_no_credentials_retry(tmp_path, native_login):
    (tmp_path / "garmin_tokens.json").write_bytes(b"old-token")
    GarminChinaDownloader(username="test", password="test", tokenstore=tmp_path).login()
    assert native_login.logins == 0


def test_failed_promotion_preserves_original(tmp_path, native_login, monkeypatch):
    token = tmp_path / "garmin_tokens.json"
    token.write_bytes(b"old-token")
    replace = Path.replace
    def fail_token_replace(source, target):
        if target == token:
            raise OSError("simulated write failure")
        return replace(source, target)
    monkeypatch.setattr(Path, "replace", fail_token_replace)
    downloader = GarminChinaDownloader(username="test", password="test", tokenstore=tmp_path)
    with pytest.raises(GarminServiceError):
        downloader.login()
    assert token.read_bytes() == b"old-token"
    assert downloader.client is None
    assert not list(tmp_path.glob("*.part"))
