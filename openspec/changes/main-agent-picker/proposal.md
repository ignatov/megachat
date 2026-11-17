# Proposal

## Why

The user asked on 2026-11-17: "давай добавим выбор ризонинга и модели в наш мегачат через acp". Today the model and the
reasoning level of the main agent are the settings `coordinator.model` and `coordinator.thinking`. The user changes
them only by a request in the chat, so the main agent changes its own setting. Air has a model chooser and a reasoning
chooser in the prompt box of each ACP agent, but they stay empty for Megachat.

A check of the Air source (`plugins/air`, 2026-11-17) found how Air fills the choosers:

- Air reads `configOptions` of `session/new` and `session/load`, and `config_option_update`. It finds the model chooser
  by the category `model` and the reasoning chooser by the category `thought_level`, never by the option ID.
- Air sends `session/set_config_option` when the user picks a value.
- The level names of pi-ai (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) are names that Air knows.
- Air has no use for the older `models` field and `session/set_model`: it reads only `configOptions`.

## What Changes

Where it shows: the prompt box of Air, and the setting file.

- **Two options in each session.** `session/new` and `session/load` answer with `configOptions`: `model` (category
  `model`) and `thought_level` (category `thought_level`). Each has the current value.
- **The models.** The Claude models of the registry that are not a dated copy and not Haiku: Fable, Opus and Sonnet.
  The current model is always in the list.
- **The levels.** The levels that the current model supports. A change of the model can change the list and the value
  of the level, so each update holds both options.
- **A choice.** `session/set_config_option` stores the value in `coordinator.model` or `coordinator.thinking`. The next
  turn uses it (or the end of the current turn, as each setting of `nextTurn`). The daemon sends the new options to each
  open view with `config_option_update`, also for a change that the main agent makes with `agents_settings`.
- **A refusal.** A value that is not in the list, and an unknown option, get a JSON-RPC error with a clear text.

Capabilities: modifies `settings` (ADDED requirements).

ACP extension: no extension. It uses the standard `configOptions`. `docs/air-contract.md` lists the use. Air must
not change.

## Out of scope

- The settings of the children (`children.*`), also `children.piModel`.
- The older `models` and `session/set_model`: Air does not read them.
- A model of another provider than Claude, and a Haiku model for the main agent.
