"""Edge City dashboard auth: owner email OTP on Hermes's login form."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

from hermes_cli.dashboard_auth import (
    DashboardAuthProvider,
    InvalidCodeError,
    InvalidCredentialsError,
    LoginStart,
    ProviderError,
    RefreshExpiredError,
    Session,
)

_SIG_LEN = hashlib.sha256().digest_size
_ACCESS_TTL = 12 * 60 * 60
_REFRESH_TTL = 30 * 24 * 60 * 60


def _env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if value:
        return value
    path = os.path.join(os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes")), ".env")
    try:
        prefix = f"{name}="
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                if line.startswith(prefix):
                    return line[len(prefix) :].strip().strip("'\"")
    except OSError:
        pass
    return ""


def _looks_like_code(password: str) -> bool:
    text = (password or "").strip()
    return bool(text) and text.isdigit() and 4 <= len(text) <= 10


def _post_json(url: str, body: dict) -> tuple[int, dict]:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read().decode("utf-8") or "{}"
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                parsed = {}
            return response.status, parsed if isinstance(parsed, dict) else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8") if exc.fp else ""
        try:
            parsed = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            parsed = {}
        return exc.code, parsed if isinstance(parsed, dict) else {}
    except urllib.error.URLError as exc:
        raise ProviderError(f"control plane unreachable: {exc.reason}") from exc


def _sign(payload: dict, secret: bytes) -> str:
    raw = json.dumps(payload, separators=(",", ":")).encode()
    sig = hmac.new(secret, raw, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(raw + sig).decode()


def _unsign(token: str, secret: bytes, kind: str) -> Optional[dict]:
    try:
        blob = base64.urlsafe_b64decode(token.encode())
        if len(blob) <= _SIG_LEN:
            return None
        raw, sig = blob[:-_SIG_LEN], blob[-_SIG_LEN:]
        expected = hmac.new(secret, raw, hashlib.sha256).digest()
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(raw)
    except Exception:
        return None
    if payload.get("kind") != kind or payload.get("exp", 0) <= int(time.time()):
        return None
    return payload


def _patch_hermes_login() -> None:
    """Keep Hermes's login page; Edge City email first, then the one-time code."""
    try:
        from hermes_cli.dashboard_auth import login_page
    except ImportError:
        return

    original = login_page._render_password_form
    tpl = login_page._LOGIN_HTML_TEMPLATE
    if "Edge City account" not in tpl:
        tpl = (
            tpl.replace("Nous<span class=\"dot\"></span>Research", "Edge<span class=\"dot\"></span>City")
            .replace(
                "Choose a sign-in method to continue to the Hermes Agent dashboard.",
                "Sign in with your Edge City account to continue to the Hermes Agent dashboard.",
            )
            .replace("Public bind &middot; Auth required", "Nous<span class=\"dot\"></span>Research")
            .replace("Public bind · Auth required", "Nous<span class=\"dot\"></span>Research")
        )
    if ".field[hidden]" not in tpl:
        tpl = tpl.replace(
            ".field {{",
            ".field[hidden] {{ display: none !important; }}\n  .form-title {{ display: none; }}\n  .field {{",
            1,
        )
    login_page._LOGIN_HTML_TEMPLATE = tpl

    def render(provider, next_path: str) -> str:
        html = (
            original(provider, next_path)
            .replace(">Username</span>", ">Edge City Email</span>")
            .replace(
                'type="text" name="username" autocomplete="username"',
                'type="email" name="username" autocomplete="email" placeholder="you@edgecity.live"',
            )
            .replace(">Password</span>", ">Code</span>")
            .replace(
                'type="password" name="password" autocomplete="current-password" required',
                'type="text" name="password" autocomplete="one-time-code" inputmode="numeric"',
            )
        )
        return re.sub(
            r'(<label class="field")(>\s*<span class="field-label">Code</span>)',
            r'\1 hidden style="display:none"\2',
            html,
            count=1,
        )

    login_page._render_password_form = render
    login_page._PASSWORD_FORM_SCRIPT = login_page._PASSWORD_FORM_SCRIPT.replace(
        "function handle(form) {\n    form.addEventListener('submit', function (ev) {",
        "function handle(form) {\n"
        "    var codeInput = form.querySelector('input[name=password]');\n"
        "    var codeWrap = codeInput && codeInput.closest('.field');\n"
        "    if (codeWrap) { codeWrap.hidden = true; codeWrap.style.display = 'none'; }\n"
        "    form.addEventListener('submit', function (ev) {",
    ).replace(
        "(resp.status === 401 ? 'Invalid username or password.'",
        "(resp.status === 401 ? (body.password ? 'Invalid email or code.' : 'Check your email for a code.')",
    ).replace(
        "if (err) { err.textContent = msg; err.hidden = false; }",
        "if (resp.status === 401 && !body.password && codeWrap) {\n"
        "          codeWrap.hidden = false;\n"
        "          codeWrap.style.display = '';\n"
        "        }\n"
        "        if (err) { err.textContent = msg; err.hidden = false; }",
    )


class EdgeCityDashboardAuth(DashboardAuthProvider):
    name = "edgecity"
    display_name = "Edge City"
    supports_password = True

    def __init__(self) -> None:
        self._tenant_id = _env("TENANT_ID")
        self._cp = _env("CONTROL_PLANE_URL").rstrip("/")
        self._landing = _env("LANDING_URL").rstrip("/")
        raw = _env("HERMES_DASHBOARD_SESSION_SECRET")
        self._secret = raw.encode("utf-8") if raw else secrets.token_bytes(32)
        if not self._tenant_id or not self._cp:
            raise ValueError("TENANT_ID and CONTROL_PLANE_URL are required")

    def start_login(self, *, redirect_uri: str) -> LoginStart:
        if not self._landing:
            raise ProviderError("LANDING_URL is not set")
        parsed = urllib.parse.urlparse(redirect_uri)
        if parsed.scheme not in ("http", "https") or not (parsed.path or "").endswith("/auth/callback"):
            raise ProviderError("invalid redirect_uri")
        code_verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).rstrip(b"=").decode()
        state = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
        params = urllib.parse.urlencode(
            {
                "tenantId": self._tenant_id,
                "redirect_uri": redirect_uri,
                "state": state,
            }
        )
        return LoginStart(
            redirect_url=f"{self._landing}/admin/dashboard-sso?{params}",
            cookie_payload={"hermes_session_pkce": f"state={state};verifier={code_verifier}"},
        )

    def complete_login(self, *, code: str, state: str, code_verifier: str, redirect_uri: str) -> Session:
        status, body = _post_json(
            f"{self._cp}/dashboard-admin/exchange",
            {"ticket": code, "tenantId": self._tenant_id},
        )
        if status == 400 or status == 401:
            raise InvalidCodeError("admin ticket rejected")
        if status != 200:
            raise ProviderError(f"admin exchange failed ({status})")
        return self._mint(str(body.get("user_id") or "admin"), str(body.get("email") or ""), "admin")

    def complete_password_login(self, *, username: str, password: str) -> Session:
        email = (username or "").strip().lower()
        if not email or "@" not in email:
            raise InvalidCredentialsError("invalid credentials")
        if not _looks_like_code(password):
            status, _body = _post_json(
                f"{self._cp}/tenants/{self._tenant_id}/dashboard-auth/send",
                {"email": email},
            )
            if status >= 500:
                raise ProviderError("could not send login code")
            raise InvalidCredentialsError("code sent")
        status, body = _post_json(
            f"{self._cp}/tenants/{self._tenant_id}/dashboard-auth/verify",
            {"email": email, "code": password.strip()},
        )
        if status != 200:
            if status >= 500:
                raise ProviderError("could not verify login code")
            raise InvalidCredentialsError("invalid credentials")
        return self._mint(str(body.get("user_id") or email), email, "owner")

    def verify_session(self, *, access_token: str) -> Optional[Session]:
        payload = _unsign(access_token, self._secret, "access")
        if payload is None:
            return None
        return self._session(
            str(payload.get("sub") or ""),
            str(payload.get("email") or ""),
            str(payload.get("role") or "owner"),
            int(payload["exp"]),
            access_token,
            "",
        )

    def refresh_session(self, *, refresh_token: str) -> Session:
        if not refresh_token:
            raise RefreshExpiredError("no refresh token")
        payload = _unsign(refresh_token, self._secret, "refresh")
        if payload is None:
            raise RefreshExpiredError("refresh token expired or invalid")
        return self._mint(
            str(payload.get("sub") or ""),
            str(payload.get("email") or ""),
            str(payload.get("role") or "owner"),
        )

    def revoke_session(self, *, refresh_token: str) -> None:
        return None

    def _mint(self, user_id: str, email: str, role: str) -> Session:
        now = int(time.time())
        exp = now + _ACCESS_TTL
        access = _sign({"sub": user_id, "email": email, "role": role, "kind": "access", "exp": exp}, self._secret)
        refresh = _sign(
            {"sub": user_id, "email": email, "role": role, "kind": "refresh", "exp": now + _REFRESH_TTL},
            self._secret,
        )
        return self._session(user_id, email, role, exp, access, refresh)

    def _session(self, user_id: str, email: str, role: str, exp: int, access: str, refresh: str) -> Session:
        return Session(
            user_id=user_id,
            email=email,
            display_name=email or user_id,
            org_id=role,
            provider=self.name,
            expires_at=exp,
            access_token=access,
            refresh_token=refresh,
        )


def register(ctx) -> None:
    try:
        ctx.register_dashboard_auth_provider(EdgeCityDashboardAuth())
    except ValueError:
        return
    _patch_hermes_login()
