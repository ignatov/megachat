# Rules for agents

Megachat is an ACP agent in plain Node.js ESM. `README.md` tells what it does and how to run it.

## Changes go through OpenSpec

`openspec/specs/` gives the present behavior of Megachat, one capability in each folder (`openspec list --specs`).
`openspec/config.yaml` holds the constraints of the project and the rules for each artifact. A record of a manual
check is in `docs/manual-checks.md`.

1. A behavior change starts as a proposal, before the code: `/opsx:propose <idea>` in Claude Code,
   `$openspec-propose` in Codex. Use `/opsx:explore` first when the idea is not settled.
2. The author approves the proposal. Then `/opsx:apply` makes its tasks.
3. `/opsx:archive` merges the deltas of the change into `openspec/specs/`.

A change of a present behavior is a MODIFIED delta of its requirement in `openspec/specs/<capability>/spec.md`, not a
new requirement next to it. A fix that brings back a specified behavior needs no proposal. When the code is correct and
the spec is not, correct the spec in the same commit.

A requirement names its tests in a `Tests:` line. `openspec validate --all --strict` must pass.

## The state of the user

- Never start `src/main.mjs` without a state directory of the task. Pass the directory argument, or set `MEGACHAT_HOME`
  to a temporary directory. `~/.jetbrains/air/megachat` holds the real conversation of the user.
- Never print, copy or commit the token of a `connection.json`.
- Never run `install` without `MEGACHAT_ACP_CONFIG` set to a temporary file. `~/.jetbrains/acp.json` holds the entry
  that the IDE of the user starts. `test/state-guard.mjs` sets the variable for each test.

## Tests

- Run `npm test` after each change.
- Run `npm run test:bundle` after a change of `build.mjs` or of a dependency.
- Run `npm run test:package` after a change of `package.json`, of the launcher, of `install`, or of a path into
  `node_modules`. It installs about 870 MB into a temporary npm cache.

## Code and documents

- Put each user-visible string in `resources/Megachat.properties`.
- A change of an ACP extension updates `docs/air-contract.md`, and it needs the same change in Air.
- Write each text in [ASD-STE100 Simplified Technical English](https://www.asd-ste100.org/), as the IntelliJ monorepo
  does. This covers a comment, a document and a commit message. Use short sentences, the active voice and the
  articles. Use one term for one concept.

## Releases

- Never run `npm run release` without a request of the user. It pushes a tag and makes a public GitHub release.
  `npm run release -- --dry-run` changes nothing.

## Commits

- The subject is one sentence that states the new behavior.
- The body gives the reason, then a `Tests:` paragraph and a `Left out:` paragraph.
