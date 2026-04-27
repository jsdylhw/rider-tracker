# Strava FIT Upload Demo

Standalone demo for uploading a local FIT file to Strava.

The demo keeps Strava app credentials and OAuth tokens in a local config file,
similar to the Strava MCP server:

```text
~/.config/rider-tracker-strava-demo/config.json
```

Do not commit this file. It contains secrets and access tokens.

## Run

```bash
cd /home/liuhaowen/codes/rider-tracker
node demos/strava-fit-upload-demo/server.js
```

Open:

```text
http://localhost:8797
```

## Strava App Settings

Create or open your Strava API app:

```text
https://www.strava.com/settings/api
```

Set the authorization callback domain to:

```text
localhost
```

The demo uses this callback URL:

```text
http://localhost:8797/api/auth/callback
```

Required scopes:

```text
activity:write,activity:read_all
```

## Flow

1. Save your Strava Client ID and Client Secret.
2. Click Connect Strava and finish OAuth in the browser.
3. Select a `.fit` file.
4. Upload it and wait for Strava to return an `activity_id`.

