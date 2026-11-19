## 1. The files of Air

- [x] 1.1 Add `REGISTRY_AGENT`, `overlayPath()` with `MEGACHAT_ACP_OVERLAY`, `installedAgentsPath()` with `MEGACHAT_ACP_INSTALLED`, `registryAgent()`, the lenient read of the overlay file, `writeOverlayEntry()` and `removeOverlayEntry()` to `src/MegachatInstall.mjs`. Set the variables in `test/state-guard.mjs`. Cover them in `test/install.test.mjs`.

## 2. install and setup.sh

- [x] 2.1 Add the case of the registry agent and the summary line to `install`. Show the summary line in `setup.sh`. Cover "Registry agent at install", "Overlay entry of a checkout" and "Summary line of install" in `test/install.test.mjs` and `test/setup.test.mjs`.

## 3. The dialog

- [x] 3.1 Add `secondEntry()` and `removeSecondEntry()` to `src/MegachatInstall.mjs`, the dialog to `src/AcpBridge.mjs`, the route `/acp-entry` to `src/DaemonServer.mjs`, and the key `acpEntry` to `src/Settings.mjs`. Cover "Dialog about a second entry" in `test/acp-entry.test.mjs`.

## 4. uninstall

- [x] 4.1 Remove the own overlay entry. Cover "Overlay entry at uninstall" in `test/uninstall.test.mjs`.

## 5. Documents and checks

- [x] 5.1 Add each string to `resources/Megachat.properties`, and update `docs/air-contract.md` and `README.md`.
- [x] 5.2 Run `npm test`, `npm run test:package` and `openspec validate --all --strict`.
- [ ] 5.3 Manual check on an IDE build with JetBrains/ultimate#1899: with both agents, the dialog shows after the open of a Megachat row, and Remove removes the entry.
