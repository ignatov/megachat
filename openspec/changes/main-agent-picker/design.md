# Design

## Decisions

1. **`configOptions` only.** Air reads the category. Megachat gives the ID `model` for the model and `thought_level`
   for the level, as the ACP guide names them. Each is a `select` with the `currentValue`.
2. **One source of truth.** The options come from `MegachatSettings.mainAgent()`. A value is stored by the same
   `set` that `agents_settings` uses, so the validation is one place. The settings keys stay `coordinator.model` and
   `coordinator.thinking`. Children keep their keys.
3. **The list of models.** The registry models with the provider `anthropic`, the ID `claude-(fable|opus|sonnet)-…`
   and no date suffix (`-YYYYMMDD`). The stored model is added when the filter drops it. The value is
   `provider/model ID`, as the setting has it. The name is the name of the registry.
4. **The list of levels.** `getSupportedThinkingLevels(model)`: for Claude Opus 5.5 these are `low`, `medium`,
   `high`, `xhigh` and `max`. The value is the level name.
5. **A model change keeps the level when it can.** When the stored level is not a level of the new model, the daemon
   stores the level that `clampThinkingLevel` of pi-ai gives (the next supported level) together with the model, so the level does not fall back to the
   default.
6. **Daemon routes.** `GET /main-agent` gives the options. `POST /main-agent` with `{ option, value }` stores a value.
   A refusal is `409` with the code `settingValue` (or `settingKey`). The event type `mainAgent` of `/events` gives the
   options when a view connects and after each change of the model or the level. An older client ignores the event.
7. **ACP messages.** Read: `session/set_config_option`. Written: `configOptions` in the answer of `session/new` and
   `session/load`, `config_option_update` (the full list of options). An older daemon refuses `GET /main-agent`: the
   view then gives no `configOptions`.
8. **Refusal text.** The bridge answers an invalid value with the code `-32602` and the text of `error.settingValue`
   (or `error.settingKey`). The text names the allowed values.
9. **State.** `settings.json` gets no new key. An older state directory works as it is.
10. **Daemon and restart.** The choice is in `settings.json`, so it stays through a disconnect and a restart. A turn
    that runs keeps its model (see `settingsChanged`): the change applies at the end of that turn.

## Risks

- A model change breaks the prompt cache of the conversation once. Air shows the model name, so the user sees the
  choice. The setting `cache.ttl` is not touched.
- The user picks Sonnet and the main agent gets weaker. The user decides: the list is the choice.
