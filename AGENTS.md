# Rules for agents

Megachat is an ACP agent in plain Node.js ESM. `README.md` tells what it does and how to run it.

## The state of the user

- Never start `src/main.mjs` without a state directory of the task. Pass the directory argument, or set `MEGACHAT_HOME`
  to a temporary directory. `~/.jetbrains/air/megachat` holds the real conversation of the user.
- Never print, copy or commit the token of a `connection.json`.

## Tests

- Run `npm test` after each change.
- Run `npm run test:bundle` after a change of `build.mjs` or of a dependency.

## Code and documents

- Put each user-visible string in `resources/Megachat.properties`.
- A behavior change updates `docs/spec.md` and its `[@test]` lines in the same commit.
- A change of an ACP extension updates `docs/air-contract.md`, and it needs the same change in Air.
- Write each text in [ASD-STE100 Simplified Technical English](https://www.asd-ste100.org/), as the IntelliJ monorepo
  does. This covers a comment, a document and a commit message. Use short sentences, the active voice and the
  articles. Use one term for one concept.

## Commits

- The subject is one sentence that states the new behavior.
- The body gives the reason, then a `Tests:` paragraph and a `Left out:` paragraph.
