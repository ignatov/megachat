# Design

## Decisions

1. The default in `src/Settings.mjs` is `true`. The stored value of a user has priority, so `false` stays `false`.
2. The default of the `showInProject` option of `admitChild` is `true` too, so that a caller without the option and the
   setting agree.
3. The onboarding has no text about this setting, so it needs no change.
