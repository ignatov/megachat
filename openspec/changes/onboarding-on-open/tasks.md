# Tasks

## 1. State and driver

- [x] 1.1 Add the field `onboardingOffer` and `writeOnboardingNote` to `src/MegachatState.mjs`, and `dropped` in `submit`.
- [x] 1.2 Add `src/MegachatOnboarding.mjs` and start it in `src/main.mjs` after the version record. Close it at the stop.
- [x] 1.3 Add `onboarding.offer` to `resources/Megachat.properties` and the paragraph to `resources/instructions-onboarding.md`.

## 2. Tests and documents

- [x] 2.1 Add `test/onboarding.test.mjs`: a case for each scenario of the delta.
- [x] 2.2 Update `docs/air-contract.md` (the note) and `README.md`.
- [x] 2.3 Run `npm test`, `npm run test:bundle` and `openspec validate --all --strict`.
