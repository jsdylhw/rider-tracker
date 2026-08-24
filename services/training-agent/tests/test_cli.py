from __future__ import annotations

from typer.testing import CliRunner

from app.cli import app


def test_cli_exposes_main_agent_commands_and_removes_old_agent_command():
    result = CliRunner().invoke(app, ["--help"])

    assert result.exit_code == 0
    assert "chat" in result.output
    assert "workflow" not in result.output
    assert " agent " not in result.output
    assert "fit-ask" not in result.output
    assert "fit-chat" not in result.output

    missing = CliRunner().invoke(app, ["agent", "你好"])
    assert missing.exit_code != 0
    assert CliRunner().invoke(app, ["workflow", "你好"]).exit_code != 0
    assert CliRunner().invoke(app, ["fit-ask"]).exit_code != 0
    assert CliRunner().invoke(app, ["fit-chat"]).exit_code != 0


def test_sync_garmin_command_calls_operation_tool(monkeypatch):
    captured: dict[str, object] = {}

    def fake_sync_garmin_activities_tool(count: int, *, force_download: bool = False):
        captured["count"] = count
        captured["force_download"] = force_download
        return {"status": "ok", "downloaded": 0, "skipped": 1}

    monkeypatch.setattr("app.cli.sync_garmin_activities_tool", fake_sync_garmin_activities_tool)

    result = CliRunner().invoke(app, ["sync-garmin", "--count", "3"])

    assert result.exit_code == 0
    assert captured["count"] == 3
    assert captured["force_download"] is False
    assert '"status": "ok"' in result.output


def test_sync_garmin_command_hides_traceback_locals(monkeypatch):
    def fail_sync(*args, **kwargs):
        secret = "must-not-appear"
        raise RuntimeError("connection failed")

    monkeypatch.setattr("app.cli.sync_garmin_activities_tool", fail_sync)

    result = CliRunner().invoke(app, ["sync-garmin", "--count", "10"])

    assert result.exit_code == 1
    assert "Garmin 同步失败：connection failed" in result.output
    assert "Traceback" not in result.output
    assert "must-not-appear" not in result.output


def test_analyze_file_command_uses_operation_tool_and_resolves_path(tmp_path, monkeypatch):
    fit = tmp_path / "activity.fit"
    fit.write_bytes(b"fit")
    captured = {}

    def fake_analyze_fit_file_tool(path: str, *, force: bool = False):
        captured["path"] = path
        captured["force"] = force
        return {"status": "ok", "fit_path": path}

    monkeypatch.setattr("app.cli.analyze_fit_file_tool", fake_analyze_fit_file_tool)

    result = CliRunner().invoke(app, ["analyze-file", str(fit), "--force"])

    assert result.exit_code == 0
    assert captured == {"path": str(fit.resolve()), "force": True}
    assert '"status": "ok"' in result.output


def test_chat_one_shot_calls_main_agent(monkeypatch):
    def fake_run_tool_loop(*args, **kwargs):
        assert args[0] == "分析所有历史活动"
        return {
            "answer": "整体总结",
            "status": "completed",
            "log_path": "log/tool_loop_test.md",
            "current_fit_file": None,
        }

    monkeypatch.setattr("app.cli.run_tool_loop", fake_run_tool_loop)

    result = CliRunner().invoke(app, ["chat", "分析所有历史活动"])

    assert result.exit_code == 0
    assert "整体总结" in result.output


def test_strava_oauth_commands_do_not_require_an_existing_access_token(monkeypatch):
    captured = []

    class FakeSink:
        def __init__(self, *, require_access_token: bool = True):
            captured.append(require_access_token)

        def build_authorize_url(self, **kwargs):
            return "https://example.test/authorize"

        def exchange_authorization_code(self, code):
            return {"access_token": "new-token", "code": code}

    monkeypatch.setattr("app.cli.StravaSink", FakeSink)

    auth_url = CliRunner().invoke(app, ["strava-auth-url"])
    exchange = CliRunner().invoke(app, ["strava-exchange-code", "callback-code"])

    assert auth_url.exit_code == 0
    assert "authorize" in auth_url.output
    assert exchange.exit_code == 0
    assert "new-token" in exchange.output
    assert captured == [False, False]
