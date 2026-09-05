from __future__ import annotations

import json
import os
import stat
import time
from unittest.mock import MagicMock, patch

import pytest

from integrations.strava import StravaSink, _missing_activity_write


def _assert_token_file_permissions(path):
    mode = path.stat().st_mode
    if os.name == "nt":
        # Windows st_mode does not describe ACL access. Verify the supported
        # read/write attributes; the JSON and token rotation assertions still run.
        assert mode & stat.S_IREAD
        assert mode & stat.S_IWRITE
    else:
        assert stat.S_IMODE(mode) == 0o600


def _make_sink(config_overrides: dict | None = None) -> StravaSink:
    """Create a StravaSink with a pre-set access_token, skipping real auth."""
    config = {"strava": {"access_token": "test_token_123"}}
    if config_overrides:
        config["strava"].update(config_overrides)
    return StravaSink(config)


class TestMissingActivityWrite:
    def test_detects_missing_permission(self):
        error_data = {
            "errors": [
                {
                    "resource": "AccessToken",
                    "field": "activity:write_permission",
                    "code": "missing",
                }
            ]
        }
        assert _missing_activity_write(error_data) is True

    def test_no_errors_key(self):
        assert _missing_activity_write({"message": "ok"}) is False

    def test_errors_not_list(self):
        assert _missing_activity_write({"errors": "some error"}) is False

    def test_other_error_type(self):
        assert _missing_activity_write({"errors": [{"resource": "Activity", "field": "name"}]}) is False


class TestStravaSinkInit:
    def test_uses_access_token_directly(self, tmp_path):
        sink = StravaSink({
            "strava": {
                "access_token": "direct_token_123",
                "token_store": str(tmp_path / "strava_tokens.json"),
            }
        })
        assert sink.access_token == "direct_token_123"

    @patch("integrations.strava.requests.post")
    def test_refreshes_with_client_credentials(self, mock_post, tmp_path):
        mock_response = MagicMock()
        mock_response.json.return_value = {"access_token": "refreshed_token"}
        mock_response.ok = True
        mock_post.return_value = mock_response

        config = {
            "strava": {
                "client_id": "123",
                "client_secret": "abc",
                "refresh_token": "refresh_old",
                "token_store": str(tmp_path / "strava_tokens.json"),
            }
        }
        sink = StravaSink(config)
        assert sink.access_token == "refreshed_token"

    def test_raises_without_credentials(self, tmp_path):
        config = {"strava": {"token_store": str(tmp_path / "strava_tokens.json")}}
        with pytest.raises(RuntimeError, match="access_token"):
            StravaSink(config)

    @patch("integrations.strava.requests.post")
    def test_persists_rotated_refresh_token(self, mock_post, tmp_path):
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "access_token": "refreshed_token",
            "refresh_token": "refresh_new",
            "expires_at": int(time.time()) + 3600,
        }
        mock_response.ok = True
        mock_post.return_value = mock_response
        token_store = tmp_path / "strava_tokens.json"
        config = {
            "strava": {
                "client_id": "123",
                "client_secret": "abc",
                "refresh_token": "refresh_old",
                "token_store": str(token_store),
            }
        }

        sink = StravaSink(config)

        assert sink.access_token == "refreshed_token"
        assert json.loads(token_store.read_text(encoding="utf-8")) == {
            "access_token": "refreshed_token",
            "refresh_token": "refresh_new",
            "expires_at": mock_response.json.return_value["expires_at"],
        }
        _assert_token_file_permissions(token_store)

    @patch("integrations.strava.requests.post")
    def test_reuses_unexpired_persisted_access_token(self, mock_post, tmp_path):
        token_store = tmp_path / "strava_tokens.json"
        token_store.write_text(
            json.dumps({
                "access_token": "cached_token",
                "refresh_token": "refresh_current",
                "expires_at": int(time.time()) + 3600,
            }),
            encoding="utf-8",
        )
        config = {
            "strava": {
                "client_id": "123",
                "client_secret": "abc",
                "refresh_token": "refresh_old",
                "token_store": str(token_store),
            }
        }

        sink = StravaSink(config)

        assert sink.access_token == "cached_token"
        mock_post.assert_not_called()

    def test_reads_legacy_rider_default_token_envelope(self, tmp_path):
        token_store = tmp_path / "strava_tokens.json"
        token_store.write_text(
            json.dumps({
                "default": {
                    "access_token": "rider_token",
                    "refresh_token": "rider_refresh",
                    "expires_at": int(time.time()) + 3600,
                    "athlete": {"id": 42},
                }
            }),
            encoding="utf-8",
        )

        sink = StravaSink({"strava": {"token_store": str(token_store)}})

        assert sink.access_token == "rider_token"
        assert sink.connection_status()["athlete"]["id"] == 42
        assert json.loads(token_store.read_text(encoding="utf-8")) == {
            "access_token": "rider_token",
            "refresh_token": "rider_refresh",
            "expires_at": sink.connection_status()["expires_at"],
            "athlete": {"id": 42},
        }
        _assert_token_file_permissions(token_store)

    @patch("integrations.strava.requests.post")
    def test_uses_still_valid_cached_token_when_refresh_network_fails(self, mock_post, tmp_path):
        token_store = tmp_path / "strava_tokens.json"
        token_store.write_text(
            json.dumps({
                "access_token": "cached_token",
                "refresh_token": "refresh_current",
                "expires_at": int(time.time()) + 30,
            }),
            encoding="utf-8",
        )
        mock_post.side_effect = __import__("requests").RequestException("TLS failed")
        config = {
            "strava": {
                "client_id": "123",
                "client_secret": "abc",
                "token_store": str(token_store),
            }
        }

        sink = StravaSink(config)

        assert sink.access_token == "cached_token"


class TestStravaSinkBuildAuthorizeUrl:
    def test_first_oauth_does_not_require_existing_token(self):
        sink = StravaSink(
            {"strava": {"client_id": "12345", "client_secret": "secret"}},
            require_access_token=False,
        )

        assert sink.access_token is None
        assert "client_id=12345" in sink.build_authorize_url()

    def test_builds_url(self):
        sink = _make_sink({"client_id": "12345"})
        url = sink.build_authorize_url()
        assert "client_id=12345" in url
        assert "response_type=code" in url
        # URL-encoded scope
        assert "scope=read%2C" in url
        assert "read_all" in url
        assert "activity%3Awrite" in url

    def test_custom_scope(self):
        sink = _make_sink({"client_id": "12345"})
        url = sink.build_authorize_url(scope="activity:read_all")
        assert "activity%3Aread_all" in url
        assert "activity%3Awrite" not in url

    def test_raises_without_client_id(self):
        sink = _make_sink({"client_id": ""})
        with pytest.raises(RuntimeError, match="client_id"):
            sink.build_authorize_url()


class TestStravaSinkUpload:
    @patch("integrations.strava.requests.post")
    def test_upload_fit_file(self, mock_post, tmp_path):
        mock_response = MagicMock()
        mock_response.json.return_value = {"id": 12345, "status": "pending"}
        mock_response.ok = True
        mock_post.return_value = mock_response

        fit_file = tmp_path / "test_activity.fit"
        fit_file.write_bytes(b"mock fit content")

        sink = _make_sink()
        result = sink.upload_fit(
            str(fit_file), title="Test Ride", description="Test desc", sport_type="VirtualRide",
        )

        assert result["id"] == 12345
        mock_post.assert_called_once()
        assert mock_post.call_args.kwargs["data"]["sport_type"] == "VirtualRide"

    def test_upload_nonexistent_file(self):
        sink = _make_sink()
        with pytest.raises(FileNotFoundError):
            sink.upload_fit("/tmp/nonexistent_activity.fit")

    def test_upload_wrong_extension(self, tmp_path):
        wrong_file = tmp_path / "test.txt"
        wrong_file.write_text("not a fit")
        sink = _make_sink()
        with pytest.raises(ValueError, match=".fit"):
            sink.upload_fit(str(wrong_file))


class TestStravaSinkSegments:
    @patch("integrations.strava.requests.get")
    def test_explores_riding_segments(self, mock_get):
        response = MagicMock()
        response.ok = True
        response.json.return_value = {"segments": [{"id": 1, "name": "test"}]}
        mock_get.return_value = response
        sink = _make_sink()

        result = sink.explore_segments("29.0,118.0,30.0,119.0")

        assert result["segments"][0]["id"] == 1
        assert mock_get.call_args.kwargs["params"]["activity_type"] == "riding"

    def test_rejects_invalid_segment_bounds(self):
        with pytest.raises(ValueError, match="rectangle"):
            _make_sink().explore_segments("30,118,29,119")

    @patch("integrations.strava.requests.get")
    def test_gets_segment_detail(self, mock_get):
        response = MagicMock()
        response.ok = True
        response.json.return_value = {"id": 123, "map": {"polyline": "encoded"}}
        mock_get.return_value = response

        result = _make_sink().get_segment(123)

        assert result["id"] == 123
        assert mock_get.call_args.args[0].endswith("/segments/123")

    @patch("integrations.strava.time.sleep")
    @patch("integrations.strava.requests.get")
    def test_retries_transient_segment_read_failure(self, mock_get, mock_sleep):
        response = MagicMock()
        response.ok = True
        response.json.return_value = {"segments": [{"id": 1}]}
        mock_get.side_effect = [
            __import__("requests").exceptions.SSLError("TLS EOF"),
            response,
        ]

        result = _make_sink().explore_segments("29.0,118.0,30.0,119.0")

        assert result["segments"][0]["id"] == 1
        assert mock_get.call_count == 2
        mock_sleep.assert_called_once_with(0.25)

    @patch("integrations.strava.time.sleep")
    @patch("integrations.strava.requests.get")
    def test_does_not_retry_segment_http_error(self, mock_get, mock_sleep):
        response = MagicMock()
        response.ok = False
        response.status_code = 429
        response.json.return_value = {"message": "Rate Limit Exceeded"}
        mock_get.return_value = response

        with pytest.raises(RuntimeError, match="HTTP 429"):
            _make_sink().get_segment(123)

        mock_get.assert_called_once()
        mock_sleep.assert_not_called()


class TestStravaSinkRoutes:
    @patch("integrations.strava.requests.get")
    def test_lists_current_athlete_routes(self, mock_get):
        athlete_response = MagicMock()
        athlete_response.ok = True
        athlete_response.json.return_value = {"id": 89811447}
        routes_response = MagicMock()
        routes_response.ok = True
        routes_response.json.return_value = [{"id": 123, "name": "三都经典线"}]
        mock_get.side_effect = [athlete_response, routes_response]

        routes = _make_sink().list_routes(per_page=200)

        assert routes[0]["name"] == "三都经典线"
        assert mock_get.call_args_list[1].args[0].endswith("/athletes/89811447/routes")
        assert mock_get.call_args_list[1].kwargs["params"] == {"page": 1, "per_page": 100}

    @patch("integrations.strava.requests.get")
    def test_exports_route_gpx(self, mock_get):
        response = MagicMock()
        response.status_code = 200
        response.content = b"<gpx><trk></trk></gpx>"
        mock_get.return_value = response

        result = _make_sink().export_route_gpx("123")

        assert result.startswith(b"<gpx")
        assert mock_get.call_args.args[0].endswith("/routes/123/export_gpx")

    def test_rejects_invalid_route_id(self):
        with pytest.raises(ValueError, match="positive integer"):
            _make_sink().export_route_gpx("not-a-route")


class TestStravaSinkUpdateDescription:
    @patch("integrations.strava.requests.put")
    def test_update_description(self, mock_put):
        mock_response = MagicMock()
        mock_response.json.return_value = {"id": 98765, "description": "new desc"}
        mock_response.ok = True
        mock_put.return_value = mock_response

        sink = _make_sink()
        result = sink.update_description("98765", "Updated description")

        assert result["id"] == 98765
        mock_put.assert_called_once()


class TestStravaSinkGetUpload:
    @patch("integrations.strava.requests.get")
    def test_get_upload_status(self, mock_get):
        mock_response = MagicMock()
        mock_response.json.return_value = {"id": 12345, "activity_id": 98765, "status": "ready"}
        mock_response.ok = True
        mock_get.return_value = mock_response

        sink = _make_sink()
        result = sink.get_upload(12345)

        assert result["status"] == "ready"
        assert result["activity_id"] == 98765


class TestStravaSinkApiError:
    @patch("integrations.strava.requests.get")
    def test_http_error(self, mock_get):
        mock_response = MagicMock()
        mock_response.json.return_value = {"message": "Not Found"}
        mock_response.ok = False
        mock_response.status_code = 404
        mock_get.return_value = mock_response

        sink = _make_sink()
        with pytest.raises(RuntimeError, match="HTTP 404"):
            sink.get_upload(99999)

    @patch("integrations.strava.requests.get")
    def test_missing_activity_write_error(self, mock_get):
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "errors": [
                {
                    "resource": "AccessToken",
                    "field": "activity:write_permission",
                    "code": "missing",
                }
            ]
        }
        mock_response.ok = False
        mock_response.status_code = 401
        mock_get.return_value = mock_response

        sink = _make_sink()
        with pytest.raises(RuntimeError, match="activity:write"):
            sink.get_upload(12345)
