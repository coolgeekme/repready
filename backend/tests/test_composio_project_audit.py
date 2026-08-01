"""Live audit against the real Composio project.

This is NOT a unit test with mocks — it actually hits Composio's API using
the `COMPOSIO_API_KEY` from `/app/backend/.env`. It verifies that the newly-
provisioned production API key can retrieve every auth config we depend on
and that Gmail specifically is a Composio-managed OAuth2 config.

Run manually after any change to `.env` credentials:
    cd /app/backend && python -m pytest tests/test_composio_project_audit.py -v

Skips itself gracefully if the SDK / network is unreachable.
"""
from __future__ import annotations

import os
import sys

import pytest


sys.path.insert(0, "/app/backend")


EXPECTED = {
    "gmail":     "ac_jzb88KeLjC9g",
    "outlook":   "ac_NQCspzK3hDsJ",
    "linkedin":  "ac_9IoFbt1WYlz3",
    "facebook":  "ac_Io99McBWntH9",
    "instagram": "ac_QECLY189pUO1",
}

# The API key must be the newly-created production key that owns the new project.
EXPECTED_API_KEY_PREFIX = "ak_kcX8"


@pytest.fixture(scope="module")
def composio_client():
    try:
        from dotenv import load_dotenv
        load_dotenv("/app/backend/.env")
        from composio import Composio
    except Exception as e:
        pytest.skip(f"Composio SDK not importable: {e!r}")
    api_key = os.environ.get("COMPOSIO_API_KEY", "")
    if not api_key.startswith(EXPECTED_API_KEY_PREFIX):
        pytest.fail(
            f"COMPOSIO_API_KEY does not start with {EXPECTED_API_KEY_PREFIX!r}; "
            f"got prefix {api_key[:8]!r}. `.env` was not updated correctly."
        )
    return Composio(api_key=api_key)


@pytest.mark.parametrize("toolkit,expected_id", list(EXPECTED.items()))
def test_new_api_key_can_retrieve_auth_config(composio_client, toolkit, expected_id):
    """Every one of the five expected auth configs must resolve via the new key."""
    try:
        cfg = composio_client.auth_configs.get(expected_id)
    except Exception as e:
        pytest.fail(
            f"auth_configs.get({expected_id!r}) for toolkit={toolkit!r} FAILED: {e!r}"
        )
    got_id = getattr(cfg, "id", None) or (cfg.get("id") if isinstance(cfg, dict) else None)
    assert got_id == expected_id, f"expected {expected_id}, got {got_id}"


def test_gmail_config_is_composio_managed_oauth2(composio_client):
    cfg = composio_client.auth_configs.get(EXPECTED["gmail"])
    managed = getattr(cfg, "is_composio_managed", None)
    if managed is None and isinstance(cfg, dict):
        managed = cfg.get("is_composio_managed")
    assert bool(managed) is True, (
        f"Gmail auth config {EXPECTED['gmail']} is NOT Composio-managed "
        f"(is_composio_managed={managed!r})"
    )
    # Toolkit sanity check.
    toolkit = getattr(cfg, "toolkit", None) or (cfg.get("toolkit") if isinstance(cfg, dict) else None)
    slug = getattr(toolkit, "slug", None) if toolkit else None
    if slug is None and isinstance(toolkit, dict):
        slug = toolkit.get("slug")
    assert (slug or "").lower() == "gmail", f"toolkit slug is {slug!r}, expected 'gmail'"


def test_no_old_project_configs_referenced_by_env():
    """Our `.env` must not reference any of the deprecated auth config IDs.
    We don't require these configs to be deleted from the Composio dashboard
    — the user can clean them up there. What matters is that the backend
    never routes traffic to them again.
    """
    from dotenv import dotenv_values
    env = dotenv_values("/app/backend/.env")
    OLD_IDS = {
        "ac_PB3OpzQ4iyZ_",   # old customized Gmail (blocked scopes)
        "ac_xdxvKCPIYO1H",   # dynamically-created Gmail from removed resolver
        "ac_AgbcO8xE8C4O",   # old-project LinkedIn
        "ac_gbTI-sLndWAg",   # old-project Instagram
        "ac_HVGdfG7dKSeS",   # old-project Facebook
    }
    referenced = {k: v for k, v in env.items() if v in OLD_IDS}
    assert not referenced, (
        f"`.env` still references deprecated auth config IDs: {referenced!r}"
    )
