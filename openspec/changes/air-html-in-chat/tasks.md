# Tasks

## 1. Checks before the code

- [ ] 1.1 In a temporary `MEGACHAT_HOME` with Air: log the `initialize` and `session/new` that Air sends to Megachat (no token in the log). Record in `docs/manual-checks.md`: the capabilities, and whether `additionalDirectories` or the `air-views` path arrives. Check which table of the state keeps the last value of the support (decision 3).
- [ ] 1.2 By hand, give the model the text of `resources/air-html.md` in a test chat of Megachat. Check that Air draws the fence, and that a stream with a chunk inside the fence ends in a page. Record the result.
- [ ] 1.3 File the IJAI ticket on `ignatov` only after the author says "да" (the three points of `proposal.md`).

## 2. The feature

- [ ] 2.1 Add `resources/air-html.md` (ASD-STE100, from the rules of `SKILL.md`) and the setting `chat.html` with its reader and its default in `src/` settings code.
- [ ] 2.2 Add the section to the instructions of the main agent in `src/PiMegachatService.mjs` when the support is on (decision 2). Pass the support of the view to the daemon with the attach in `src/AcpBridge.mjs`.
- [ ] 2.3 Add the strings for the setting to `resources/Megachat.properties` and the rule "show a child result as a page only when the user asks for a visual" to the section.
- [ ] 2.4 Add `test/chat-html.test.mjs`: a case for each scenario of the delta. Add a case with a fence split into chunks to the stream tests. Check the `Tests:` lines. Run `npm test`.

## 3. Documents

- [ ] 3.1 Add the setting `chat.html` to `README.md`. Add the use of the capability to `docs/air-contract.md` (read only, until the ticket).
- [ ] 3.2 Live check: ask "draw the open tasks as a chart" in Megachat in Air. Record it in `docs/manual-checks.md`.
- [ ] 3.3 Run `npm test` and `openspec validate air-html-in-chat --strict`.

## Workflow follow-up

- Run `openspec validate --all --strict` after the archive.
