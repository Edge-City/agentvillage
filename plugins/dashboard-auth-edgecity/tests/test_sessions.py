"""Session security boundaries; CP transport is isolated from identity integration smoke."""
import pytest


@pytest.fixture
def provider(tmp_path, monkeypatch, load_plugin):
    module = load_plugin()
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("TENANT_ID", "tenant-a")
    monkeypatch.setenv("CONTROL_PLANE_URL", "http://127.0.0.1:8080")
    monkeypatch.setattr(module, "_post_json", lambda *args: (200, {"ok": True}))
    return module, module.EdgeCityDashboardAuth()


def test_logout_revokes_access_and_refresh_across_restart(provider):
    module, auth = provider
    session = auth._mint("owner-id", "owner@example.org", "owner")
    restarted = module.EdgeCityDashboardAuth()
    assert restarted.verify_session(access_token=session.access_token).user_id == "owner-id"
    restarted.revoke_session(refresh_token=session.refresh_token)
    assert auth.verify_session(access_token=session.access_token) is None
    with pytest.raises(module.RefreshExpiredError):
        auth.refresh_session(refresh_token=session.refresh_token)


def test_refresh_is_one_use_and_reuse_revokes_family(provider):
    module, auth = provider
    first = auth._mint("owner-id", "owner@example.org", "owner")
    second = auth.refresh_session(refresh_token=first.refresh_token)
    assert second.refresh_token != first.refresh_token
    with pytest.raises(module.RefreshExpiredError):
        auth.refresh_session(refresh_token=first.refresh_token)
    assert auth.verify_session(access_token=second.access_token) is None
    with pytest.raises(module.RefreshExpiredError):
        auth.refresh_session(refresh_token=second.refresh_token)


def test_refresh_never_extends_absolute_expiry(provider, monkeypatch):
    module, auth = provider
    now = 1800000000
    monkeypatch.setattr(module.time, "time", lambda: now)
    first = auth._mint("owner-id", "owner@example.org", "owner")
    original = module._unsign(first.refresh_token, auth._secret, "refresh")["exp"]
    now += module._REFRESH_TTL - 1
    second = auth.refresh_session(refresh_token=first.refresh_token)
    assert second.expires_at == original
    now += 1
    assert auth.verify_session(access_token=second.access_token) is None
    with pytest.raises(module.RefreshExpiredError):
        auth.refresh_session(refresh_token=second.refresh_token)


def test_shared_environment_key_cannot_cross_tenants_or_homes(provider, tmp_path, monkeypatch):
    module, auth = provider
    monkeypatch.setenv("HERMES_DASHBOARD_SESSION_SECRET", "same-key")
    first = auth._mint("owner-id", "owner@example.org", "owner")
    monkeypatch.setenv("TENANT_ID", "tenant-b")
    other = module.EdgeCityDashboardAuth()
    assert other.verify_session(access_token=first.access_token) is None
    with pytest.raises(module.RefreshExpiredError):
        other.refresh_session(refresh_token=first.refresh_token)
    monkeypatch.setenv("TENANT_ID", "tenant-a")
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "other-home"))
    assert module.EdgeCityDashboardAuth().verify_session(access_token=first.access_token) is None


def test_owner_reassignment_or_suspension_revokes_session(provider, monkeypatch):
    module, auth = provider
    session = auth._mint("owner-id", "owner@example.org", "owner")
    monkeypatch.setattr(module, "_post_json", lambda *args: (401, {}))
    assert auth.verify_session(access_token=session.access_token) is None
    monkeypatch.setattr(module, "_post_json", lambda *args: (200, {"ok": True}))
    assert auth.verify_session(access_token=session.access_token) is None


def test_authorization_outage_fails_closed_without_destroying_session(provider, monkeypatch):
    module, auth = provider
    session = auth._mint("owner-id", "owner@example.org", "owner")
    monkeypatch.setattr(module, "_post_json", lambda *args: (503, {}))
    with pytest.raises(module.ProviderError):
        auth.verify_session(access_token=session.access_token)
    monkeypatch.setattr(module, "_post_json", lambda *args: (200, {"ok": True}))
    assert auth.verify_session(access_token=session.access_token).user_id == "owner-id"
