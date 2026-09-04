"""Low-level Strava HTTP client for OAuth, FIT upload, and description updates.

Token 管理策略:
- 优先复用本地尚未过期的 access_token.
- 需要时用 client_id/secret/refresh_token 自动刷新并持久化轮换 token.
- 首次 OAuth 的授权 URL / code exchange 可在尚无 access_token 时执行.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import requests

from project_paths import resolve_project_path, runtime_paths
from settings import load_config

STRAVA_API_BASE = "https://www.strava.com/api/v3"
STRAVA_OAUTH_AUTHORIZE_URL = "https://www.strava.com/oauth/authorize"
STRAVA_OAUTH_TOKEN_URL = "https://www.strava.com/oauth/token"
ACCESS_TOKEN_REFRESH_LEEWAY_SECONDS = 60


class StravaSink:
    """Strava v3 API 封装:上传,状态轮询,运动员信息,描述更新.

    Activity:write 权限是必需的——如果 token 缺少此权限,会在 API 报错时
    给出明确的重授权指引.
    """

    name = "strava"

    def __init__(
        self,
        config: dict[str, Any] | None = None,
        *,
        require_access_token: bool = True,
    ):
        root_config = config if config is not None else load_config()
        self.config = root_config.get("strava", root_config)
        configured_store = self.config.get("token_store") or os.environ.get("STRAVA_TOKEN_STORE")
        self.token_store = (
            resolve_project_path(str(configured_store))
            if configured_store else runtime_paths().strava_token_store
        )
        self._legacy_token_envelope = False
        self._stored_tokens = self._load_token_store()
        if self._legacy_token_envelope:
            self._persist_token_response(self._stored_tokens)
        self.access_token: str | None = self._access_token() if require_access_token else None

    def upload_fit(
        self, fit_path: str, *,
        title: str | None = None, description: str | None = None,
        trainer: bool = False, commute: bool = False,
        external_id: str | None = None,
        sport_type: str | None = None,
    ) -> dict[str, Any]:
        """上传 FIT 文件到 Strava,返回 upload 对象(含 upload_id 用于轮询)."""
        path = Path(fit_path)
        if not path.exists():
            raise FileNotFoundError(path)
        if path.suffix.lower() != ".fit":
            raise ValueError(f"Only .fit uploads are supported: {path}")

        data = {
            "data_type": "fit",
            "trainer": int(bool(trainer)),
            "commute": int(bool(commute)),
        }
        if title:
            data["name"] = title
        if description:
            data["description"] = description
        if external_id:
            # 用于去重:同一 external_id 不会重复创建活动
            data["external_id"] = external_id
        if sport_type:
            data["sport_type"] = sport_type

        with path.open("rb") as f:
            response = requests.post(
                f"{STRAVA_API_BASE}/uploads",
                headers=self._headers(),
                data=data,
                files={"file": (path.name, f, "application/octet-stream")},
                timeout=float(self.config.get("timeout_seconds", 120)),
            )
        return self._json_or_raise(response)

    def get_upload(self, upload_id: int | str) -> dict[str, Any]:
        """查询上传处理状态."""
        response = requests.get(
            f"{STRAVA_API_BASE}/uploads/{upload_id}",
            headers=self._headers(),
            timeout=float(self.config.get("timeout_seconds", 120)),
        )
        return self._json_or_raise(response)

    def wait_for_upload(
        self, upload_id: int | str, *,
        timeout_seconds: int = 180, interval_seconds: int = 5,
    ) -> dict[str, Any]:
        """轮询直到上传处理完成(有 activity_id 或 error),或超时."""
        deadline = time.time() + timeout_seconds
        last = self.get_upload(upload_id)
        while time.time() < deadline:
            if last.get("activity_id") or last.get("error"):
                return last
            time.sleep(interval_seconds)
            last = self.get_upload(upload_id)
        return last

    def get_athlete(self) -> dict[str, Any]:
        """获取当前授权用户的信息(用于验证 token 是否有效)."""
        response = requests.get(
            f"{STRAVA_API_BASE}/athlete",
            headers=self._headers(),
            timeout=float(self.config.get("timeout_seconds", 120)),
        )
        return self._json_or_raise(response)

    def list_routes(self, *, page: int = 1, per_page: int = 50) -> list[dict[str, Any]]:
        """读取当前授权运动员在 Strava 中保存的路线列表."""
        normalized_page = max(1, int(page))
        normalized_per_page = max(1, min(100, int(per_page)))
        athlete = self.get_athlete()
        athlete_id = athlete.get("id")
        if not athlete_id:
            raise RuntimeError("Strava athlete id is unavailable")
        response = self._get_route_response(
            f"/athletes/{athlete_id}/routes",
            params={"page": normalized_page, "per_page": normalized_per_page},
        )
        payload = self._json_or_raise(response)
        if isinstance(payload, dict) and isinstance(payload.get("data"), list):
            payload = payload["data"]
        if not isinstance(payload, list):
            raise RuntimeError("Strava routes response is not a list")
        return payload

    def export_route_gpx(self, route_id: int | str) -> bytes:
        """下载一条已有 Strava 路线的 GPX，包括 Strava 提供的海拔轨迹."""
        normalized_id = self._positive_route_id(route_id)
        response = self._get_route_response(f"/routes/{normalized_id}/export_gpx")
        if response.status_code >= 400:
            self._json_or_raise(response)
        if not response.content:
            raise RuntimeError("Strava route GPX is empty")
        return response.content

    def _get_route_response(
        self,
        path: str,
        *,
        params: dict[str, Any] | None = None,
    ) -> requests.Response:
        """执行只读路线请求，并对瞬时网络错误作有限重试."""
        attempts = max(1, min(3, int(self.config.get("route_read_attempts", 2))))
        delay = max(0.0, float(self.config.get("route_retry_delay_seconds", 0.25)))
        for attempt in range(attempts):
            try:
                return requests.get(
                    f"{STRAVA_API_BASE}{path}",
                    headers=self._headers(),
                    params=params,
                    timeout=float(self.config.get("timeout_seconds", 120)),
                )
            except requests.RequestException:
                if attempt + 1 >= attempts:
                    raise
                time.sleep(delay * (attempt + 1))
        raise AssertionError("unreachable")

    @staticmethod
    def _positive_route_id(route_id: int | str) -> int:
        try:
            normalized_id = int(route_id)
        except (TypeError, ValueError) as exc:
            raise ValueError("route_id must be a positive integer") from exc
        if normalized_id <= 0:
            raise ValueError("route_id must be a positive integer")
        return normalized_id

    def connection_status(self) -> dict[str, Any]:
        """Return non-secret local OAuth state for Rider's connection UI."""
        token = self._stored_tokens
        return {
            "connected": bool(token.get("access_token") or self.config.get("access_token")),
            "configured": bool(
                self.config.get("client_id") and self.config.get("client_secret")
            ),
            "athlete": token.get("athlete"),
            "expires_at": self._token_expiry(),
        }

    def explore_segments(self, bounds: str) -> dict[str, Any]:
        """查询一个 WGS-84 矩形范围内的热门骑行 Segment 样本."""
        values = [float(value.strip()) for value in str(bounds).split(",")]
        if len(values) != 4:
            raise ValueError("bounds must be south,west,north,east")
        south, west, north, east = values
        if not (-90 <= south < north <= 90 and -180 <= west < east <= 180):
            raise ValueError("bounds must be a valid south,west,north,east rectangle")
        return self._get_segment_json(
            "explore",
            params={
                "bounds": ",".join(str(value) for value in values),
                "activity_type": "riding",
            },
        )

    def get_segment(self, segment_id: int | str) -> dict[str, Any]:
        """读取一个公开 Strava Segment 的详细属性和完整 polyline."""
        try:
            normalized_id = int(segment_id)
        except (TypeError, ValueError) as exc:
            raise ValueError("segment_id must be a positive integer") from exc
        if normalized_id <= 0:
            raise ValueError("segment_id must be a positive integer")
        return self._get_segment_json(str(normalized_id))

    def _get_segment_json(
        self,
        path: str,
        *,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Run an idempotent Segment GET with a bounded transient-network retry."""
        attempts = max(1, min(3, int(self.config.get("segment_read_attempts", 2))))
        delay = max(0.0, float(self.config.get("segment_retry_delay_seconds", 0.25)))
        for attempt in range(attempts):
            try:
                response = requests.get(
                    f"{STRAVA_API_BASE}/segments/{path}",
                    headers=self._headers(),
                    params=params,
                    timeout=float(self.config.get("timeout_seconds", 120)),
                )
                return self._json_or_raise(response)
            except requests.RequestException:
                if attempt + 1 >= attempts:
                    raise
                time.sleep(delay * (attempt + 1))
        raise AssertionError("unreachable")

    def update_description(self, activity_id: str, markdown: str) -> dict[str, Any]:
        """更新已有 Strava 活动的描述."""
        response = requests.put(
            f"{STRAVA_API_BASE}/activities/{activity_id}",
            headers=self._headers(),
            data={"description": markdown},
            timeout=float(self.config.get("timeout_seconds", 120)),
        )
        return self._json_or_raise(response)

    def build_authorize_url(
        self, *, redirect_uri: str = "http://localhost",
        scope: str = "read,read_all,activity:read_all,activity:write",
        approval_prompt: str = "force",
        state: str | None = None,
    ) -> str:
        """生成 Strava OAuth 授权 URL,用户在浏览器中打开以授权应用."""
        client_id = self.config.get("client_id")
        if not client_id:
            raise RuntimeError("Please configure strava.client_id in config.yaml")
        query = urlencode({
            "client_id": client_id, "redirect_uri": redirect_uri,
            "response_type": "code", "approval_prompt": approval_prompt,
            "scope": scope,
            **({"state": state} if state else {}),
        })
        return f"{STRAVA_OAUTH_AUTHORIZE_URL}?{query}"

    def exchange_authorization_code(self, code: str) -> dict[str, Any]:
        """用 OAuth 回调返回的 code 换取 refresh_token 和 access_token."""
        client_id = self.config.get("client_id")
        client_secret = self.config.get("client_secret")
        if not client_id or not client_secret:
            raise RuntimeError("Please configure strava.client_id and strava.client_secret in config.yaml")
        response = requests.post(
            STRAVA_OAUTH_TOKEN_URL,
            data={
                "client_id": client_id, "client_secret": client_secret,
                "code": code, "grant_type": "authorization_code",
            },
            timeout=float(self.config.get("timeout_seconds", 120)),
        )
        data = self._json_or_raise(response)
        self._persist_token_response(data)
        return data

    def _access_token(self) -> str:
        """获取 access_token:优先复用有效缓存,否则刷新,最后兼容直配 token."""
        client_id = self.config.get("client_id")
        client_secret = self.config.get("client_secret")
        refresh_token = self._stored_tokens.get("refresh_token") or self.config.get("refresh_token")
        cached_token = self._stored_tokens.get("access_token") or self.config.get("access_token")
        expires_at = self._token_expiry()

        if cached_token and self._token_is_valid(expires_at, leeway=ACCESS_TOKEN_REFRESH_LEEWAY_SECONDS):
            return str(cached_token)

        if client_id and client_secret and refresh_token:
            try:
                return self._refresh_access_token(client_id, client_secret, str(refresh_token))
            except requests.RequestException:
                # A short TLS/proxy failure should not block an operation when
                # a locally cached token is still valid at this moment.
                if cached_token and self._token_is_valid(expires_at):
                    return str(cached_token)
                raise

        if cached_token:
            return str(cached_token)

        raise RuntimeError(
            "Please configure strava.access_token or "
            "strava.client_id/client_secret/refresh_token in config.yaml"
        )

    def _refresh_access_token(self, client_id: str, client_secret: str, refresh_token: str) -> str:
        response = requests.post(
            STRAVA_OAUTH_TOKEN_URL,
            data={
                "client_id": client_id, "client_secret": client_secret,
                "refresh_token": refresh_token, "grant_type": "refresh_token",
            },
            timeout=float(self.config.get("timeout_seconds", 120)),
        )
        data = self._json_or_raise(response)
        token = data.get("access_token")
        if not token:
            raise RuntimeError(f"Strava token refresh did not return access_token: {data}")
        self._persist_token_response(data)
        return str(token)

    def _load_token_store(self) -> dict[str, Any]:
        try:
            data = json.loads(self.token_store.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        if not isinstance(data, dict):
            return {}
        # One-time compatibility with Rider's former per-user Node token file.
        default_token = data.get("default")
        if isinstance(default_token, dict):
            self._legacy_token_envelope = True
            return default_token
        return data

    def _persist_token_response(self, data: dict[str, Any]) -> None:
        """Persist the latest OAuth tokens without rewriting config.yaml.

        Strava can rotate refresh_token responses. Keeping this independent
        local store preserves comments and hand-managed credentials in config.
        """
        token_keys = ("access_token", "refresh_token", "expires_at", "expires_in", "athlete")
        updated = {
            **self._stored_tokens,
            **{key: data[key] for key in token_keys if data.get(key) is not None},
        }
        if not updated.get("access_token") or not updated.get("refresh_token"):
            return

        self.token_store.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.token_store.with_name(f".{self.token_store.name}.tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(updated, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
            os.replace(temporary, self.token_store)
            os.chmod(self.token_store, 0o600)
        finally:
            temporary.unlink(missing_ok=True)
        self._stored_tokens = updated

    def _token_expiry(self) -> int | None:
        value = self._stored_tokens.get("expires_at", self.config.get("expires_at"))
        try:
            return int(value) if value is not None else None
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _token_is_valid(expires_at: int | None, *, leeway: int = 0) -> bool:
        return expires_at is not None and expires_at > time.time() + leeway

    def _headers(self) -> dict[str, str]:
        if not self.access_token:
            self.access_token = self._access_token()
        return {"Authorization": f"Bearer {self.access_token}"}

    @staticmethod
    def _json_or_raise(response: requests.Response) -> dict[str, Any]:
        """解析 JSON 响应,非 2xx 时抛出带上下文的 RuntimeError.

        特别处理 activity:write_permission missing 错误,
        给出清晰的重授权指引.
        """
        try:
            data = response.json()
        except ValueError:
            data = {"text": response.text[:1000]}
        if not response.ok:
            if _missing_activity_write(data):
                raise RuntimeError(
                    "Strava API failed: token is missing activity:write permission. "
                    "Generate a new Strava authorization URL with scope "
                    "'read,read_all,activity:read_all,activity:write', authorize it, exchange the returned code, "
                    "and update strava.refresh_token in config.yaml."
                )
            raise RuntimeError(f"Strava API failed: HTTP {response.status_code}; body={data}")
        return data if isinstance(data, dict) else {"data": data}


def _missing_activity_write(data: dict[str, Any]) -> bool:
    """检测 Strava 返回的错误中是否包含 activity:write 权限缺失."""
    errors = data.get("errors")
    if not isinstance(errors, list):
        return False
    for error in errors:
        if not isinstance(error, dict):
            continue
        if (
            error.get("resource") == "AccessToken"
            and error.get("field") == "activity:write_permission"
            and error.get("code") == "missing"
        ):
            return True
    return False
