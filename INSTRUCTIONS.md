# Video calls instructions

Package `ourapps-ae/video-calls` version `0.5.0`. It provides `facility` (type `ae/media-session`, version 1.0.0) and optionally requires `configuration` (type `ae/video-calls-configuration`, version 1.0.0).

## For the agent

- Select this component when the recipe's `video` answer is yes (people see and hear each other at the table). Skip it otherwise.
- Provider: LiveKit (cloud or self-hosted). Settings: `enabled` (default true), `serviceUrl` (the LiveKit address, https), `keyReference` and `secretReference` (secret references; never ask for or write a value into source). The deployment resolves the references and builds the server environment `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` with `videoEnvironment`.
- Choose the profile from the `scale` answer (see `suitability.json`): `free` (LiveKit Build plan) up to 100 people connected at once and a hard monthly cap; `paid` (Ship) up to 1,000; `scale` up to 5,000.
- Supply `configuration`: `roomPrefix` including its separator (match `realtime-rooms`), the authenticated participant identity, the capture callback, sound callbacks and the mode event name (same as `display-mode`).
- Connect the provided `facility` port to the room service (`realtime-rooms` `Services.videoGrant`) and to each client that shows video. Select `display-mode` alongside so a shared board never captures.

## For the developer

- Install paths: `components/video-calls/server/video.ts`, `.../web/video.ts`, `.../apple/Sources/VideoSession.swift`, `.../android/src/main/java/ae/video/VideoSession.kt`, `.../verification/` (helpers for aepm checks).
- Server: `videoEnvironment(settings, secrets)` builds the environment (empty when disabled or incomplete). `videoGrant(env, tableId, playerId, name, now, publish, roomPrefix)` returns `{url, token, room}` or null when credentials are missing. Use `publish=false` for spectators and never issue a display grant. Grants last six hours with ten seconds of clock tolerance. `listRooms(env, now, roomPrefix, fetcher)` lists provider rooms (account-wide, then filtered by prefix).
- Web: `new Video(onChange, {canCapture, soundOn, modeEvent})`, then `connect(url, token, roomName)`. A false `canCapture` on the mode event disconnects and forgets the grant. `hold`, `setMic`, `setCam`, `setSpeaker`, `armIdle`, `resume`, `close`.
- Apple: `VideoSession` on the main actor; add `tests/apple/CameraTests.swift` to a host in the same module. Android: `ae.video.VideoSession(context, canCapture)` on the main thread.
- Your application renders participants; this component does not.
- Real media, device and provider behaviour are not verified here; checks use fixtures and doubles.

## How to check

From the component directory (needs `npm ci --ignore-scripts --no-audit --no-fund` once for the npm suites):

- `node --test tests/video.test.mjs tests/browser-process.test.mjs tests/provider.test.mjs`
- `python3 -m unittest discover -s tests -p 'test_dependency_metadata.py'` (also `test_apple_results.py`, `test_native_runner.py`)
- `npm run typecheck`
- Heavy native suites (`scripts/platform-check.py apple-build|apple|android`, Xcode and Gradle) and the deployed provider suite need prepared machines and credentials; run them only deliberately.
- `python3.12 -B tools/check_component.py components/video-calls` from the workspace root runs the required-local suites.

In the application, join with two browsers, confirm each sees the other, enter display mode and confirm capture stops.
