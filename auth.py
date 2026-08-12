"""
GitHub-based login for the web dashboard, plus a separate shared-secret
check for the MCP endpoint (GitHub's OAuth flow doesn't fit a non-browser
MCP client). Both are opt-in: if their env vars aren't set, the dashboard
runs exactly as before (open, no login) -- so this never breaks an existing
single-machine setup that never configured it.

Uses GitHub's Device Flow, not the usual browser-redirect OAuth flow -- no
callback URL to register or keep in sync with a roaming LAN IP (this
dashboard has none of the fixed hostname a redirect-based flow needs). The
user opens github.com/login/device, enters an 8-character code, and this
server polls for the result -- works identically from any network. Device
flow also doesn't require a client secret at all (it's a public-client
flow, same model the `gh` CLI uses), so setup is just one Client ID.

Session cookies are HMAC-signed with a key generated once and persisted to
.session_secret (git-ignored) so logins survive a server restart. Stdlib
only (hmac/urllib) -- no new pip dependency for a couple of signed cookies
and a handful of outbound HTTP calls.
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
MCP_SHARED_SECRET = os.environ.get("MCP_SHARED_SECRET")

GITHUB_AUTH_ENABLED = bool(GITHUB_OAUTH_CLIENT_ID)

SESSION_COOKIE = "iac_session"
DEVICE_PENDING_COOKIE = "iac_device_pending"
SESSION_TTL_SECONDS = 30 * 24 * 3600  # 30 days

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


def create_device_pending_cookie_value(
    device_code: str, user_code: str, verification_uri: str, interval: int, expires_at: int
) -> str:
    """expires_at is an ABSOLUTE unix timestamp -- GitHub's real, fixed
    expiry for this device_code (~15 min from when it was first issued),
    not a relative "extend by N seconds" duration. Every re-sign (idempotent
    reuse in /auth/login, the interval bump on slow_down) must pass the
    SAME expires_at through unchanged. Resetting it to a fresh window on
    each re-sign was an earlier bug here: it kept the login page reporting
    "waiting for approval" well past the point GitHub had already expired
    the underlying code, so approving it then failed with a confusing
    "we couldn't find anything" on GitHub's own page."""
    remaining = max(1, expires_at - int(time.time()))
    return _sign(f"{device_code}|{user_code}|{verification_uri}|{interval}|{expires_at}", remaining)


def read_device_pending_cookie(token: str | None) -> dict | None:
    """Returns {device_code, user_code, verification_uri, interval,
    expires_at}, or None if missing/tampered/expired. Carrying
    user_code/verification_uri here (not just device_code) lets
    /auth/login redisplay an in-flight login unchanged instead of minting
    a fresh code every time it's hit -- which matters because it gets hit
    by more than just the user opening the page (e.g. a browser's own
    background devtools probe reaching an unauthenticated path redirects
    here too), and silently replacing an in-flight code the user is
    actively approving is exactly the bug this avoids."""
    if not token:
        return None
    value = _verify(token)
    if not value:
        return None
    try:
        device_code, user_code, verification_uri, interval, expires_at = value.split("|", 4)
        expires_at = int(expires_at)
        if time.time() > expires_at:
            return None
        return {
            "device_code": device_code,
            "user_code": user_code,
            "verification_uri": verification_uri,
            "interval": int(interval),
            "expires_at": expires_at,
        }
    except ValueError:
        return None


def request_device_code() -> dict:
    """Blocking network call -- run via asyncio.to_thread from an async
    route. Returns GitHub's {device_code, user_code, verification_uri,
    expires_in, interval}."""
    data = urllib.parse.urlencode({"client_id": GITHUB_OAUTH_CLIENT_ID, "scope": "read:user"}).encode()
    req = urllib.request.Request(
        "https://github.com/login/device/code",
        data=data,
        headers={"Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode())


def poll_device_token(device_code: str) -> dict:
    """Blocking network call -- run via asyncio.to_thread from an async
    route. GitHub answers with HTTP 200 either way -- {access_token: ...}
    on success, or {error: "authorization_pending" | "slow_down" |
    "expired_token" | "access_denied"} while waiting/on failure."""
    data = urllib.parse.urlencode(
        {
            "client_id": GITHUB_OAUTH_CLIENT_ID,
            "device_code": device_code,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        }
    ).encode()
    req = urllib.request.Request(
        "https://github.com/login/oauth/access_token",
        data=data,
        headers={"Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode())


def fetch_github_user(access_token: str) -> dict:
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
