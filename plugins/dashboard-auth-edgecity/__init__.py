"""Edge City dashboard auth: owner email OTP on Hermes's login form."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
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
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ProviderError("control plane unavailable") from exc


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
    if not isinstance(payload, dict) or payload.get("kind") != kind or not isinstance(payload.get("exp"), int) or payload["exp"] <= int(time.time()):
        return None
    return payload


_LOGIN_SCRIPT = """
<script>
(function () {
  function handle(form) {
    var emailInput = form.querySelector('input[name=username]');
    var codeInput = form.querySelector('input[name=password]');
    var emailWrap = emailInput && emailInput.closest('.field');
    var codeWrap = codeInput && codeInput.closest('.field');
    var codeLabel = codeWrap && codeWrap.querySelector('.field-label');
    var back = form.querySelector('.back-email');
    var title = document.querySelector('.card h1');
    var subtitle = document.querySelector('.subtitle');
    var btn = form.querySelector('button[type=submit]');
    var emailTitle = title ? title.textContent : '';
    var emailSubtitle = subtitle ? subtitle.textContent : '';
    if (codeWrap) { codeWrap.hidden = true; codeWrap.style.display = 'none'; }
    if (codeLabel) codeLabel.hidden = true;
    function showCode(email) {
      if (emailWrap) { emailWrap.hidden = true; emailWrap.style.display = 'none'; }
      if (codeWrap) { codeWrap.hidden = false; codeWrap.style.display = ''; }
      if (title) title.textContent = 'Enter verification code';
      if (subtitle) subtitle.textContent = 'We sent a 6-digit code to ' + email;
      if (btn) btn.textContent = 'Verify';
      if (back) back.hidden = false;
      if (codeInput) { codeInput.value = ''; codeInput.focus(); }
    }
    function showEmail() {
      if (emailWrap) { emailWrap.hidden = false; emailWrap.style.display = ''; }
      if (codeWrap) { codeWrap.hidden = true; codeWrap.style.display = 'none'; }
      if (title) title.textContent = emailTitle;
      if (subtitle) subtitle.textContent = emailSubtitle;
      if (btn) btn.textContent = 'Sign in';
      if (back) back.hidden = true;
      if (codeInput) codeInput.value = '';
      if (emailInput) emailInput.focus();
    }
    if (back) back.addEventListener('click', showEmail);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var err = form.querySelector('.form-error');
      ev.stopImmediatePropagation();
      if (err) { err.hidden = true; err.textContent = ''; }
      if (btn) btn.disabled = true;
      var body = {
        provider: form.getAttribute('data-provider') || '',
        username: (emailInput && emailInput.value) || '',
        password: (codeInput && codeInput.value) || '',
        next: (form.querySelector('input[name=next]') || {}).value || ''
      };
      fetch('/auth/password-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin'
      }).then(function (resp) {
        if (resp.ok) {
          return resp.json().then(function (data) {
            window.location.assign((data && data.next) || '/');
          });
        }
        if (resp.status === 401 && !body.password) {
          showCode(body.username);
          if (btn) btn.disabled = false;
          return;
        }
        return resp.json().catch(function () { return {}; }).then(function (data) {
          var msg = resp.status === 429
            ? 'Too many attempts. Please wait and try again.'
            : (resp.status === 401 ? 'Invalid email or code.' : 'Sign-in failed. Please try again.');
          if (resp.status === 503 && typeof data.detail === 'string') {
            msg = data.detail.replace(/^Provider unreachable: /, '');
          }
          if (err) { err.textContent = msg; err.hidden = false; }
          if (btn) btn.disabled = false;
        });
      }).catch(function () {
        if (err) { err.textContent = 'Network error. Please try again.'; err.hidden = false; }
        if (btn) btn.disabled = false;
      });
    }, true);
  }
  var forms = document.querySelectorAll('form.provider-form[data-provider="edgecity"]');
  for (var i = 0; i < forms.length; i++) { handle(forms[i]); }
})();
</script>
"""




def _patch_hermes_login() -> None:
    """Adapt only this provider's form; leave other providers and branding alone."""
    try:
        from hermes_cli.dashboard_auth import login_page
    except ImportError:
        return
    original = login_page._render_password_form
    if getattr(original, "_edgecity", False):
        return
    def render(provider, next_path: str) -> str:
        if provider.name != "edgecity":
            return original(provider, next_path)
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
                'type="text" name="password" aria-label="Verification code" autocomplete="one-time-code" inputmode="numeric" maxlength="10" placeholder="000000"',
            )
            .replace(
                '<button class="provider-btn" type="submit">Sign in</button>',
                '<button class="provider-btn" type="submit">Sign in</button>\n'
                '        <button type="button" class="back-email" hidden>Use a different email</button>',
            )
        )
        return re.sub(
            r'(<label class="field")(>\s*<span class="field-label">Code</span>)',
            r'\1 hidden style="display:none"\2',
            html,
            count=1,
        ) + _LOGIN_SCRIPT

    render._edgecity = True
    login_page._render_password_form = render


class EdgeCityDashboardAuth(DashboardAuthProvider):
    name = "edgecity"
    display_name = "Edge City"
    supports_password = True

    def __init__(self) -> None:
        self._tenant_id = _env("TENANT_ID")
        self._cp = _env("CONTROL_PLANE_URL").rstrip("/")
        self._landing = _env("LANDING_URL").rstrip("/")
        if not self._tenant_id or not self._cp:
            raise ValueError("TENANT_ID and CONTROL_PLANE_URL are required")
        home = os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes"))
        private = os.path.join(home, ".dashboard-auth-edgecity")
        os.makedirs(private, mode=0o700, exist_ok=True)
        os.chmod(private, 0o700)
        self._db_path = os.path.join(private, "sessions.sqlite3")
        fd = os.open(self._db_path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        os.chmod(self._db_path, 0o600)
        with self._db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS identity (tenant TEXT PRIMARY KEY, secret BLOB NOT NULL)")
            db.execute("INSERT OR IGNORE INTO identity VALUES (?, ?)", (self._tenant_id, secrets.token_bytes(32)))
            self._secret = bytes(db.execute("SELECT secret FROM identity WHERE tenant = ?", (self._tenant_id,)).fetchone()[0])
            db.execute("""CREATE TABLE IF NOT EXISTS sessions (
                sid TEXT PRIMARY KEY, tenant TEXT NOT NULL, subject TEXT NOT NULL,
                email TEXT NOT NULL, role TEXT NOT NULL, absolute_exp INTEGER NOT NULL,
                refresh_hash TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)""")

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self._db_path, timeout=10)
        try:
            with db:
                yield db
        finally:
            db.close()

    def _authorize(self, payload: dict) -> bool:
        status, body = _post_json(
            f"{self._cp}/tenants/{self._tenant_id}/dashboard-auth/authorize",
            {"user_id": payload["sub"], "email": payload["email"], "role": payload["role"]},
        )
        if status in (401, 403, 404):
            return False
        if status != 200 or body.get("ok") is not True:
            raise ProviderError("session authorization unavailable")
        return True

    def _payload(self, token: str, kind: str):
        payload = _unsign(token, self._secret, kind)
        if payload is None or payload.get("tenant") != self._tenant_id:
            return None
        if not all(isinstance(payload.get(key), str) for key in ("sid", "sub", "email", "role")):
            return None
        return payload

    def _active(self, db, payload):
        row = db.execute(
            "SELECT subject, email, role, absolute_exp, refresh_hash, revoked FROM sessions WHERE sid = ? AND tenant = ?",
            (payload["sid"], self._tenant_id),
        ).fetchone()
        if not row or row[5] or row[3] <= int(time.time()) or tuple(row[:3]) != (payload["sub"], payload["email"], payload["role"]):
            return None
        return row

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
        if not body.get("user_id"):
            raise ProviderError("admin exchange returned no identity")
        return self._mint(str(body["user_id"]), str(body.get("email") or ""), "admin")

    def complete_password_login(self, *, username: str, password: str) -> Session:
        email = (username or "").strip().lower()
        if not email or "@" not in email:
            raise InvalidCredentialsError("invalid credentials")
        if not password.strip():
            status, _body = _post_json(
                f"{self._cp}/tenants/{self._tenant_id}/dashboard-auth/send",
                {"email": email},
            )
            if status != 200 or _body.get("ok") is not True:
                raise ProviderError("Too many attempts. Please wait." if status == 429 else "Could not send login code.")
            raise InvalidCredentialsError("code sent")
        if not _looks_like_code(password):
            raise InvalidCredentialsError("invalid code")
        status, body = _post_json(
            f"{self._cp}/tenants/{self._tenant_id}/dashboard-auth/verify",
            {"email": email, "code": password.strip()},
        )
        if status != 200:
            if status >= 500 or status == 429:
                raise ProviderError("Too many attempts. Please wait." if status == 429 else "Could not verify login code.")
            raise InvalidCredentialsError("invalid credentials")
        if not body.get("user_id") or str(body.get("email") or "").lower() != email:
            raise ProviderError("identity response invalid")
        return self._mint(str(body["user_id"]), email, "owner")

    def verify_session(self, *, access_token: str) -> Optional[Session]:
        payload = self._payload(access_token, "access")
        if payload is None:
            return None
        with self._db() as db:
            if not self._active(db, payload):
                return None
        if not self._authorize(payload):
            self._revoke(payload["sid"])
            return None
        return self._session(payload["sub"], payload["email"], payload["role"], payload["exp"], access_token, "")

    def refresh_session(self, *, refresh_token: str) -> Session:
        payload = self._payload(refresh_token, "refresh")
        if payload is None:
            raise RefreshExpiredError("refresh token expired or invalid")
        if not self._authorize(payload):
            self._revoke(payload["sid"])
            raise RefreshExpiredError("session no longer authorized")
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = self._active(db, payload)
            if not row:
                raise RefreshExpiredError("session revoked or expired")
            digest = hashlib.sha256(refresh_token.encode()).hexdigest()
            if not hmac.compare_digest(row[4], digest):
                db.execute("UPDATE sessions SET revoked = 1 WHERE sid = ?", (payload["sid"],))
                db.commit()
                raise RefreshExpiredError("refresh token reused; session revoked")
            session = self._tokens(payload["sub"], payload["email"], payload["role"], payload["sid"], row[3])
            db.execute("UPDATE sessions SET refresh_hash = ? WHERE sid = ?",
                       (hashlib.sha256(session.refresh_token.encode()).hexdigest(), payload["sid"]))
            return session

    def _revoke(self, sid: str) -> None:
        with self._db() as db:
            db.execute("UPDATE sessions SET revoked = 1 WHERE sid = ? AND tenant = ?", (sid, self._tenant_id))

    def revoke_session(self, *, refresh_token: str) -> None:
        payload = self._payload(refresh_token, "refresh")
        if payload:
            self._revoke(payload["sid"])

    def _mint(self, user_id: str, email: str, role: str) -> Session:
        absolute_exp = int(time.time()) + _REFRESH_TTL
        sid = secrets.token_urlsafe(32)
        session = self._tokens(user_id, email, role, sid, absolute_exp)
        with self._db() as db:
            db.execute("DELETE FROM sessions WHERE absolute_exp <= ?", (int(time.time()),))
            db.execute("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
                       (sid, self._tenant_id, user_id, email, role, absolute_exp,
                        hashlib.sha256(session.refresh_token.encode()).hexdigest()))
        return session

    def _tokens(self, user_id: str, email: str, role: str, sid: str, absolute_exp: int) -> Session:
        exp = min(int(time.time()) + _ACCESS_TTL, absolute_exp)
        common = {"sub": user_id, "email": email, "role": role, "sid": sid, "tenant": self._tenant_id}
        access = _sign({**common, "kind": "access", "exp": exp}, self._secret)
        refresh = _sign({**common, "kind": "refresh", "exp": absolute_exp, "nonce": secrets.token_urlsafe(32)}, self._secret)
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
