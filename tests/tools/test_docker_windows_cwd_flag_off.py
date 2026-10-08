"""A Windows workspace with ``docker_mount_cwd_to_workspace`` off never reaches ``docker run -w``.

Regression for #135257: on native Windows the kanban dispatcher sets ``TERMINAL_CWD`` to the task
workspace. ``_resolve_config_cwd`` binds a Windows drive cwd even with the flag off (it cannot exist
inside the Linux container) and leaves the env to retarget cwd to the mount, but
``_resolve_task_host_cwd`` refused that same path as a mount source, and the cwd guards then fell
back to ``config["cwd"]`` — the raw drive path. Every creation site must either bind the Windows
workspace or start in the backend default.
"""
from __future__ import annotations

import pytest

import tools.terminal_tool as tt
from tools.terminal_tool_config import _is_windows_drive_path

WIN_WS = r"D:\Work\kanban\t_436c966c"


@pytest.fixture
def flag_off_windows_config(monkeypatch):
    """The config ``_resolve_config_cwd`` produces for a Windows ``TERMINAL_CWD`` with the flag off."""
    monkeypatch.setenv("TERMINAL_ENV", "docker")
    config = {**tt._get_env_config(), "env_type": "docker", "docker_mount_cwd_to_workspace": False,
              "cwd": WIN_WS, "host_cwd": WIN_WS}
    monkeypatch.setattr(tt, "_get_env_config", lambda: config)
    return config


def _created(site: str, task_id, monkeypatch) -> tuple[str, str | None]:
    """``(cwd, host_cwd)`` that *site* hands to environment creation for *task_id*."""
    captured: dict = {}

    def capture(*args, **kwargs):
        captured.update(kwargs)
        return object()

    if site == "terminal":
        plan = tt._plan_execution("pwd", task_id=task_id, timeout=None, background=False, _host_local=False)
        return plan.cwd, plan.host_cwd
    if site == "file_tools":
        from tools.file_tools import _create_terminal_env_for_file_ops

        monkeypatch.setattr(tt, "_create_configured_env", capture)
        _create_terminal_env_for_file_ops(task_id or "default", tt._resolve_container_task_id(task_id))
    else:
        import tools.terminal_tool_backends as backends
        from tools.code_execution_tool import _get_or_create_env

        monkeypatch.setattr(backends, "_create_environment", capture)
        monkeypatch.setattr(tt, "_active_environments", {})
        monkeypatch.setattr(tt, "_last_activity", {})
        monkeypatch.setattr(tt, "_start_cleanup_thread", lambda: None)
        _get_or_create_env(task_id or "default")
    return captured["cwd"], captured["host_cwd"]


SITES = ["terminal", "file_tools", "execute_code"]


@pytest.mark.parametrize("site", SITES)
def test_shared_container_binds_the_windows_workspace(site, flag_off_windows_config, monkeypatch):
    monkeypatch.setenv("TERMINAL_CONTAINER_PERSISTENT", "true")

    cwd, host_cwd = _created(site, None, monkeypatch)

    # Bound, so the env retargets the drive path (or /workspace) to wherever the mount lands.
    assert host_cwd == WIN_WS
    assert cwd in (WIN_WS, "/workspace")


@pytest.mark.parametrize("site", SITES)
def test_isolated_session_without_the_bind_starts_in_the_backend_default(
        site, flag_off_windows_config, monkeypatch):
    monkeypatch.setenv("TERMINAL_CONTAINER_PERSISTENT", "false")  # per-session containers

    cwd, host_cwd = _created(site, "tui:sess-1", monkeypatch)

    # The launch env's workspace is not this session's to mount, and its drive path is no workdir.
    assert host_cwd is None
    assert not _is_windows_drive_path(cwd)
    assert cwd == "/root"
