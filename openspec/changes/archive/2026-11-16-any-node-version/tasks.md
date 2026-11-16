# Tasks

Rules for each task: never start `src/main.mjs` without a temporary state directory, never run `install` without
`MEGACHAT_ACP_CONFIG` set to a temporary file, print no token, and use no recursive delete.

## 1. Code

- [x] 1.1 Add `src/quietSqliteWarning.mjs` and import it first in `src/main.mjs`.
- [x] 1.2 Print the closing line in `install`, the error of `install` in `src/main.mjs`, and the load error in
  `bin/megachat.mjs`. Add the texts to `resources/Megachat.properties`.
- [x] 1.3 Write the log of the install line in `setup.sh`.
- [x] 1.4 State the Node.js range and the troubleshooting line in `README.md`.

## 2. Tests

- [x] 2.1 Cases in `test/install.test.mjs` and `test/setup.test.mjs` for the requirements of this change.
- [x] 2.2 `npm test` on the default Node.js and on Node.js 25.6.0. `openspec validate --all --strict`.
- [x] 2.3 `npm run test:package`, because the launcher and `install` changed. It needs the network and about 870 MB.
