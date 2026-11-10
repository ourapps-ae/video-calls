# Source mapping

Reference revision: `19905b75dbea89fbfd424d67fe26c81aaed0e018` (frozen McInPoker, read with `git show` in `mcinpoker/`). `SOURCE.json` keeps the pinned source hashes.

| Implementation file | Frozen source and lines | Generalised | Left behind |
|---|---|---|---|
| `implementation/server/video.ts` (73) | `server/src/video.ts` 1-63 (`VideoEnv`, `videoGrant`, `listRooms`, `signHs256`, `base64url`) | `roomPrefix` including its separator is a parameter; credentials come only from the caller's environment object; `listRooms` validates and converts the service address | The game's table naming and the `/video-rooms` route (`server/src/index.ts` 70-73) |
| `implementation/web/video.ts` (191) | `web/src/video.ts` 1-206 (`Video` class: `connect`, `hold`, `setMic`, `setCam`, `setSpeaker`, idle handling, monitor and cell elements) | Constructor takes `{canCapture, soundOn, modeEvent}` instead of reading the game's `sessionMode()` and sound state; generation checks reject stale completion | Game styling and participant rendering rules |
| `implementation/apple/Sources/VideoSession.swift` (288) | `ios/McInPoker/Sources/VideoSession.swift` 1-298 | Injected camera capture provider, defaults store, sound and capture callbacks | Game model and screens |
| `implementation/android/src/main/java/ae/video/VideoSession.kt` (168) | `android/app/src/main/java/com/georgemcintyre/mcinpoker/video/VideoSession.kt` 1-166 | Package `ae.video`; `canCapture` callback; internal factory and scope constructor for controlled tests | Game view model and Compose panels |
| `tests/apple/CameraTests.swift` | `ios/McInPokerTests/CameraTests.swift` 1-140 | Neutral host | Game-specific tests |

`implementation/verification/*` (provider, browser, native and Apple result helpers) was written for this component against aepm's execution context and result protocol (`interfaces/media-session-verification.json`); it has no frozen source. `scripts/` and `tests/native/` hold the standalone Apple and Android hosts and their locks (`tests/native/dependencies.json`). Fixture checks use synthetic identities and in-memory responses; the strings that look like credentials in `tests/` are test-only values.

`videoEnvironment` and the `VideoSettings` and `VideoSecrets` types in `implementation/server/video.ts` are new code with no frozen counterpart (the frozen server read the three environment variables directly).

The manifest marks the `configuration` requirement `optional: true` and the visual definition draws it as not required (video-calls-configuration is a connector for settings the component can also receive in code, so a design may leave it unconnected).
