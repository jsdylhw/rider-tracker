# Rider Tracker

Rider Tracker is a local browser-based virtual cycling app. It supports GPX route import, route simulation, live riding with Bluetooth devices, JSON/FIT export, and optional Strava OAuth/FIT upload through the bundled local server.

## Quick Start

Run from the project root:

```powershell
npm.cmd start
```

If dependencies have not been installed yet, run this once first:

```powershell
npm.cmd install
```

On macOS/Linux or shells where `npm` is not blocked:

```bash
npm start
```

Then open:

```text
http://127.0.0.1:8787
```

You can also use:

```text
http://localhost:8787
```

If PowerShell returns immediately or blocks `npm`, use `npm.cmd start`. A normal running server keeps the terminal occupied until you stop it.

To stop the server, press:

```text
Ctrl + C
```

## Local Server

The root `npm start` command runs:

```text
node src/server/index.js
```

The local server provides one app entry point:

```text
GET /        -> index.html
GET /src/*   -> frontend modules and CSS
GET /api/*   -> Strava OAuth/upload APIs
```

The export panel uses the current page origin as the default Strava server URL. The Strava server URL and user ID live under the panel's advanced settings, so the common workflow only needs the export/connect/upload buttons.

## Why node_modules Exists

`node_modules` is the local dependency folder created by `npm install`. Rider Tracker uses a small Node.js server, and that server depends on packages such as `express`, `multer`, `cors`, and `dotenv`.

Do not edit files under `node_modules`; they are third-party packages. If the folder is missing, run `npm.cmd install` again.

## Strava Setup

The app can run without Strava credentials. In that mode, route import, simulation, live riding, and JSON/FIT export still work.

If you see this warning:

```text
STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET 未配置，授权与上传接口不可用。
```

it only means Strava authorization and upload are disabled.

To enable Strava, either copy `.env.example` to `.env` in the project root:

```env
STRAVA_CLIENT_ID=your_client_id
STRAVA_CLIENT_SECRET=your_client_secret
```

The default callback URL is:

```text
http://localhost:8787/api/strava/auth/callback
```

Configure the same callback URL in the Strava API application settings.

You can also configure Strava from the browser. Click `Connect Strava`, or open:

```text
http://127.0.0.1:8787/strava/login
```

That local page saves the Client ID and Client Secret under `data/strava-config.json`, then continues to the Strava authorization page.

## Tests

Run:

```powershell
npm.cmd test
```

or:

```bash
npm test
```

## Main Features

- Import GPX routes or build route segments manually.
- Run offline cycling simulation from route and rider settings.
- Connect Bluetooth heart-rate, power-meter, and trainer devices in supported Chromium browsers.
- Export ride sessions as JSON or FIT.
- Connect Strava and upload FIT files when server credentials are configured.
- Use Street View and PiP overlays during live riding.

## Browser Notes

Use a Chromium-based browser such as Chrome or Edge. Safari and Firefox have limited Web Bluetooth and Document PiP support.
