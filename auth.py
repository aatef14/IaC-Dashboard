"""
GitHub-based login for the web dashboard, plus a separate shared-secret
check for the MCP endpoint (GitHub's OAuth flow doesn't fit a non-browser
MCP client). Both are opt-in: if their env vars aren't set, the dashboard
runs exactly as before (open, no login) -- so this never breaks an existing
single-machine setup that never configured it.

Session cookies are HMAC-signed with a key generated once and persisted to
.session_secret (git-ignored) so logins survive a server restart. Stdlib
only (hmac/urllib) -- no new pip dependency for a couple of signed cookies
and two outbound HTTP calls.
"""

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
import urllib.parse
import urllib.request

GITHUB_OAUTH_CLIENT_ID = os.environ.get("GITHUB_OAUTH_CLIENT_ID")
GITHUB_OAUTH_CLIENT_SECRET = os.environ.get("GITHUB_OAUTH_CLIENT_SECRET")
MCP_SHARED_SECRET = os.environ.get("MCP_SHARED_SECRET")

GITHUB_AUTH_ENABLED = bool(GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET)

SESSION_COOKIE = "iac_session"
STATE_COOKIE = "iac_oauth_state"
SESSION_TTL_SECONDS = 30 * 24 * 3600  # 30 days
STATE_TTL_SECONDS = 300  # just long enough to complete the GitHub redirect round trip

_SECRET_PATH = os.path.join(os.path.dirname(__file__), ".session_secret")


def _load_or_create_secret() -> bytes:
    if os.path.exists(_SECRET_PATH):
        with open(_SECRET_PATH, "rb") as f:
            key = f.read()
        if key:
            return key
    key = secrets.token_bytes(32)
    with open(_SECRET_PATH, "wb") as f:
        f.write(key)
    return key


_SECRET = _load_or_create_secret()


def _sign(value: str, ttl_seconds: int) -> str:
    payload = f"{value}:{int(time.time()) + ttl_seconds}"
    b64 = base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")
    sig = hmac.new(_SECRET, b64.encode(), hashlib.sha256).hexdigest()
    return f"{b64}.{sig}"


def _verify(token: str) -> str | None:
    try:
        b64, sig = token.split(".", 1)
    except ValueError:
        return None
    expected = hmac.new(_SECRET, b64.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        return None
    try:
        padded = b64 + "=" * (-len(b64) % 4)
        value, expires_at = base64.urlsafe_b64decode(padded).decode().rsplit(":", 1)
    except (ValueError, UnicodeDecodeError):
        return None
    if time.time() > int(expires_at):
        return None
    return value


def create_session_cookie_value(github_login: str) -> str:
    return _sign(github_login, SESSION_TTL_SECONDS)


def read_session_cookie(token: str | None) -> str | None:
    """Returns the GitHub login the cookie was issued for, or None if
    missing/tampered/expired."""
    if not token:
        return None
    return _verify(token)


def create_state_cookie_value() -> str:
    return _sign(secrets.token_urlsafe(16), STATE_TTL_SECONDS)


def state_cookie_matches(cookie_value: str | None, query_state: str | None) -> bool:
    if not cookie_value or not query_state:
        return False
    # The state param round-tripped through GitHub is itself the signed
    # cookie value verbatim -- so a valid, unexpired signature is sufficient;
    # no separate comparison needed beyond "they're the same string".
    return hmac.compare_digest(cookie_value, query_state) and _verify(cookie_value) is not None


def github_authorize_url(redirect_uri: str, state: str) -> str:
    params = urllib.parse.urlencode(
        {
            "client_id": GITHUB_OAUTH_CLIENT_ID,
            "redirect_uri": redirect_uri,
            "scope": "read:user",
            "state": state,
        }
    )
    return f"https://github.com/login/oauth/authorize?{params}"


def exchange_code_for_token(code: str, redirect_uri: str) -> str | None:
    """Blocking network call -- run via asyncio.to_thread from an async route."""
    data = urllib.parse.urlencode(
        {
            "client_id": GITHUB_OAUTH_CLIENT_ID,
            "client_secret": GITHUB_OAUTH_CLIENT_SECRET,
            "code": code,
            "redirect_uri": redirect_uri,
        }
    ).encode()
    req = urllib.request.Request(
        "https://github.com/login/oauth/access_token",
        data=data,
        headers={"Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        result = json.loads(resp.read().decode())
    return result.get("access_token")


def fetch_github_user(access_token: str) -> dict | None:
    """Blocking network call -- run via asyncio.to_thread from an async route."""
    req = urllib.request.Request(
        "https://api.github.com/user",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "IaC-Dashboard",
        },
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode())


def mcp_request_authorized(auth_header: str | None) -> bool:
    """MCP protection is a separate, simpler shared-secret check (not GitHub
    login) since Claude Code's MCP client can't do a browser OAuth redirect.
    Returns True (open) if MCP_SHARED_SECRET was never configured."""
    if not MCP_SHARED_SECRET:
        return True
    return auth_header == f"Bearer {MCP_SHARED_SECRET}"
