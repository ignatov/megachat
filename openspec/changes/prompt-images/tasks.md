# Tasks

## 1. Code

- [x] 1.1 Add `src/PromptImages.mjs`: the images of the blocks, the paths of a text, the limits and the notes. Add `test/prompt-images.test.mjs`.
- [x] 1.2 Announce `promptCapabilities.image` and accept `image` blocks in `src/AcpBridge.mjs`.
- [x] 1.3 Make the content with images in `src/PiMegachatService.mjs` and `src/MegachatState.mjs`, with the digest of decision 5.
- [x] 1.4 Add the hook `beforeRequest`, the same function in the keep-alive and the estimate, and `[image]` in the summary.
- [x] 1.5 Add the note text to `resources/Megachat.properties` and the rule to `resources/instructions.md`.
- [x] 1.6 Update `docs/air-contract.md` and `README.md` if it names the blocks.

## 2. Tests and checks

- [x] 2.1 Tests: an `image` block, the text fallback, a missing file, a file above the limit, the replay of the old images. Change the test of the refused image.
- [x] 2.2 `npm test`, `npm run test:bundle` and `openspec validate --all --strict`.
