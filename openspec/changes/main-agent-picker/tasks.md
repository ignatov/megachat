# Tasks

## 1. The daemon

- [x] 1.1 Add `mainAgent()` and `setMainAgent()` to `MegachatSettings` in `src/Settings.mjs`.
- [x] 1.2 Add the service methods, the routes `GET` and `POST /main-agent`, and the event `mainAgent` (`src/PiMegachatService.mjs`, `src/DaemonServer.mjs`, `src/main.mjs`).

## 2. The bridge

- [x] 2.1 Give `configOptions` in `session/new` and `session/load`, handle `session/set_config_option`, and send `config_option_update` (`src/AcpBridge.mjs`, `src/DaemonClient.mjs`).
- [x] 2.2 Add the strings to `resources/Megachat.properties`.

## 3. Tests and documents

- [x] 3.1 Add `test/main-agent-picker.test.mjs`: advertise, set, persist, refuse, update. Add the `Tests:` lines.
- [x] 3.2 Update `docs/air-contract.md` and `README.md`.
- [x] 3.3 Run `npm test`, `npm run test:bundle` and `openspec validate --all --strict`.
- [ ] 3.4 By hand in Air: open the prompt box, pick a model and a level, send a prompt, restart Air. Record it in `docs/manual-checks.md`.
