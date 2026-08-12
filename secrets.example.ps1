# Copy this file to secrets.local.ps1 (git-ignored) and fill in the values
# you want. start.ps1 dot-sources secrets.local.ps1 automatically if it
# exists, so these persist across restarts without retyping env vars every
# time. Leave any of these commented out / unset to skip that feature --
# the dashboard runs fine with none of this configured (see README).

# GitHub sign-in for the web dashboard. Create an OAuth App at
# https://github.com/settings/developers -- Authorization callback URL must
# be http://<the host/IP you access the dashboard at>:8765/auth/callback.
# $env:GITHUB_OAUTH_CLIENT_ID = "..."
# $env:GITHUB_OAUTH_CLIENT_SECRET = "..."

# Shared-secret protection for the /mcp endpoint (separate from GitHub
# sign-in above -- Claude Code's MCP client can't do a browser OAuth
# redirect). Pick any random string, then add the same value as an
# Authorization header in the consuming repo's .mcp.json.
# $env:MCP_SHARED_SECRET = "..."
