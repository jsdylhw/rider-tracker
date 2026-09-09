"""Garmin 中国区下载业务逻辑.

这里放可被 API、Main Agent operation 和脚本复用的下载能力。根目录脚本只负责
命令行参数和输出,避免业务模块反向导入根级脚本。
"""

from __future__ import annotations

import io
import os
import re
import zipfile
from pathlib import Path
from typing import Any
from uuid import uuid4

from project_paths import runtime_paths
from settings import cfg_bool, cfg_get, resolve_project_path

# Garmin 中国区使用独立的 OAuth 端点。
CN_DI_TOKEN_URL = "https://diauth.garmin.cn/di-oauth2-service/oauth/token"


class GarminServiceError(RuntimeError):
    """A sanitized Garmin failure that is safe to expose through APIs and Agent tools."""

    def __init__(self, code: str, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def normalize_garmin_error(exc: Exception, *, operation: str = "sync") -> GarminServiceError:
    """Separate credential failures from temporary Garmin/API connectivity failures.

    ``garminconnect`` currently wraps a failed profile/settings request in
    ``GarminConnectAuthenticationError``.  The exception type alone therefore
    cannot prove that the credentials are invalid; inspect the complete cause
    chain and only report an authentication failure for explicit evidence.
    """
    if isinstance(exc, GarminServiceError):
        return exc

    chain = _exception_chain(exc)
    text = " | ".join(str(item) for item in chain).lower()
    type_names = " ".join(type(item).__name__.lower() for item in chain)
    statuses = {
        status
        for item in chain
        if (status := _http_status(item)) is not None
    }

    if "username and password are required" in text or "please set garmin_username" in text:
        return GarminServiceError(
            "garmin_not_configured",
            "尚未配置 Garmin Connect 账号和密码。",
            retryable=False,
        )
    if 429 in statuses or "toomanyrequests" in type_names or "too many login attempts" in text:
        return GarminServiceError(
            "garmin_rate_limited",
            "Garmin Connect 请求过于频繁，请稍后再试；本次未下载活动。",
            retryable=True,
        )
    if 401 in statuses or "401 unauthorized" in text or "invalid credentials" in text:
        return GarminServiceError(
            "garmin_auth_failed",
            "Garmin Connect 登录失败，请检查账号、密码或授权状态；本次未下载活动。",
            retryable=False,
        )

    # Profile/settings failures happen after a session or token has been
    # established.  They are often transient network/service failures and must
    # not be presented as proof that the user's password is wrong.
    if "failed to retrieve social profile" in text or "invalid profile data" in text:
        return GarminServiceError(
            "garmin_profile_unavailable",
            "Garmin Connect 暂时无法读取账户资料，请稍后重试；本次未下载活动。",
            retryable=True,
        )
    if "failed to retrieve user settings" in text or "invalid user settings" in text:
        return GarminServiceError(
            "garmin_settings_unavailable",
            "Garmin Connect 暂时无法读取账户设置，请稍后重试；本次未下载活动。",
            retryable=True,
        )

    network_markers = (
        "timeout", "timed out", "connectionerror", "connection error",
        "connection reset", "max retries", "ssl", "unexpected_eof",
        "name resolution", "temporary failure", "network is unreachable",
    )
    if statuses.intersection({500, 502, 503, 504}) or any(
        marker in text or marker in type_names for marker in network_markers
    ):
        action = "登录 Garmin Connect" if operation == "login" else "连接 Garmin Connect"
        return GarminServiceError(
            "garmin_network_error",
            f"{action}时网络或服务暂时不可用，请稍后重试；本次未下载活动。",
            retryable=True,
        )

    if "authenticationerror" in type_names or "authentication failed" in text:
        return GarminServiceError(
            "garmin_auth_failed",
            "Garmin Connect 登录失败，请检查账号、密码或授权状态；本次未下载活动。",
            retryable=False,
        )
    return GarminServiceError(
        "garmin_service_error",
        "Garmin Connect 请求未能完成，请稍后重试；本次未下载活动。",
        retryable=True,
    )


def garmin_error_payload(exc: Exception, *, operation: str = "sync") -> dict[str, Any]:
    """Return the stable public error contract used by sync/workflow callers."""
    error = normalize_garmin_error(exc, operation=operation)
    return {
        "error": error.code,
        "message": str(error),
        "retryable": error.retryable,
    }


def _exception_chain(exc: Exception) -> list[BaseException]:
    chain: list[BaseException] = []
    current: BaseException | None = exc
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        chain.append(current)
        current = current.__cause__ or current.__context__
    return chain


def _http_status(exc: BaseException) -> int | None:
    value = getattr(getattr(exc, "response", None), "status_code", None)
    if value is None:
        value = getattr(exc, "status_code", None)
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def safe_filename(value: Any) -> str:
    text = str(value or "activity").strip()
    text = re.sub(r"[\\/:*?\"<>|\r\n]+", "_", text)
    text = re.sub(r"\s+", " ", text)
    return text[:120] or "activity"


def activity_base_name(activity: dict[str, Any]) -> str:
    activity_id = activity.get("activityId")
    activity_name = activity.get("activityName") or f"activity_{activity_id}"
    start_time = activity.get("startTimeLocal") or "unknown"
    return safe_filename(f"{start_time}_{activity_name}_{activity_id}")


def existing_fit_paths(output_dir: Path, activity: dict[str, Any]) -> list[Path]:
    base_name = activity_base_name(activity)
    if not output_dir.exists():
        return []
    return sorted(output_dir.glob(f"{base_name}*.fit"))


def save_original_as_fit(raw_bytes: bytes, output_dir: Path, activity: dict[str, Any]) -> list[Path]:
    """保存 Garmin ORIGINAL 下载结果,自动处理 zip 内的 FIT 文件."""
    base_name = activity_base_name(activity)

    output_dir.mkdir(parents=True, exist_ok=True)
    if not zipfile.is_zipfile(io.BytesIO(raw_bytes)):
        fit_path = output_dir / f"{base_name}.fit"
        _atomic_write_bytes(fit_path, raw_bytes)
        return [fit_path]

    saved_paths: list[Path] = []
    with zipfile.ZipFile(io.BytesIO(raw_bytes)) as zf:
        fit_names = [name for name in zf.namelist() if name.lower().endswith(".fit")]
        if not fit_names:
            zip_path = output_dir / f"{base_name}.zip"
            _atomic_write_bytes(zip_path, raw_bytes)
            raise RuntimeError(f"No .fit file found in original archive; saved zip to: {zip_path}")

        for index, member in enumerate(fit_names, start=1):
            suffix = "" if len(fit_names) == 1 else f"_{index}"
            fit_path = output_dir / f"{base_name}{suffix}.fit"
            _atomic_write_bytes(fit_path, zf.read(member))
            saved_paths.append(fit_path)

    return saved_paths


def _atomic_write_bytes(target: Path, content: bytes) -> None:
    """仅在完整内容落盘后才让文件对“已下载”检查可见。"""
    temporary = target.with_name(f".{target.name}.{uuid4().hex}.part")
    try:
        with temporary.open("wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(target)
    finally:
        if temporary.exists():
            temporary.unlink()


class GarminChinaDownloader:
    """Garmin 中国区登录与活动下载.

    封装 garminconnect 库,处理中国区 DI OAuth 端点覆盖、
    代理设置和 token 持久化。登录后才能调用 list_activities/download_original。
    """

    def __init__(
        self,
        *,
        username: str,
        password: str,
        tokenstore: str | Path | None = None,
        proxy: str | None = None,
        disable_curl_cffi: bool = False,
    ) -> None:
        self.username = username
        self.password = password
        self.tokenstore = str(tokenstore or (runtime_paths().credentials_dir / "garmin"))
        self.proxy = proxy
        self.disable_curl_cffi = disable_curl_cffi
        self.client = None
        self.Garmin = None

    def login(self) -> None:
        # 代理通过全局环境变量设置,影响整个进程的网络请求。
        if self.proxy:
            os.environ["HTTP_PROXY"] = self.proxy
            os.environ["HTTPS_PROXY"] = self.proxy
            os.environ["http_proxy"] = self.proxy
            os.environ["https_proxy"] = self.proxy

        from garminconnect import Garmin
        from garminconnect import client as garmin_client

        garmin_client.DI_TOKEN_URL = CN_DI_TOKEN_URL
        if self.disable_curl_cffi:
            garmin_client.HAS_CFFI = False

        self.Garmin = Garmin
        self.client = Garmin(self.username, self.password, is_cn=True)
        try:
            self.client.login(self.tokenstore)
        except Exception as exc:
            raise normalize_garmin_error(exc, operation="login") from exc

    def list_activities(self, count: int) -> list[dict[str, Any]]:
        if self.client is None:
            raise RuntimeError("Downloader is not logged in")
        try:
            return self.client.get_activities(0, count)
        except Exception as exc:
            raise normalize_garmin_error(exc, operation="list_activities") from exc

    def download_original(self, activity_id: Any) -> bytes:
        if self.client is None or self.Garmin is None:
            raise RuntimeError("Downloader is not logged in")
        try:
            return self.client.download_activity(
                activity_id,
                self.Garmin.ActivityDownloadFormat.ORIGINAL,
            )
        except Exception as exc:
            raise normalize_garmin_error(exc, operation="download_activity") from exc


def build_downloader(config: dict[str, Any]) -> GarminChinaDownloader:
    username = cfg_get(config, "garmin_username")
    password = cfg_get(config, "garmin_password")
    if not username or not password:
        raise RuntimeError("Please set garmin_username and garmin_password in config.yaml")

    return GarminChinaDownloader(
        username=str(username),
        password=str(password),
        tokenstore=resolve_project_path(
            cfg_get(config, "garmin_tokenstore", runtime_paths().credentials_dir / "garmin")
        ),
        proxy=cfg_get(config, "garmin_proxy"),
        disable_curl_cffi=cfg_bool(config, "disable_curl_cffi", default=False),
    )
