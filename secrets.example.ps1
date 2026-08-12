# Copy this file to secrets.local.ps1 (git-ignored) and fill in the values
# you want. start.ps1 dot-sources secrets.local.ps1 automatically if it
# exists, so these persist across restarts without retyping env vars every
# time. Leave any of these commented out / unset to skip that feature --
# the dashboard runs fine with none of this configured (see README).

# GitHub sign-in for the web dashboard (Device Flow -- see README). Create
# an OAuth App at https://github.com/settings/developers, tick "Enable
# Device Flow", then just paste its Client ID here. No client secret and no
# callback URL to keep in sync with a roaming LAN IP -- Device Flow doesn't
# use either.
# $env:GITHUB_OAUTH_CLIENT_ID = "..."

# Shared-secret protection for the /mcp endpoint (separate from GitHub
# sign-in above -- Claude Code's MCP client can't do a browser OAuth
# redirect). Pick any random string, then add the same value as an
# Authorization header in the consuming repo's .mcp.json.
# $env:MCP_SHARED_SECRET = "..."
