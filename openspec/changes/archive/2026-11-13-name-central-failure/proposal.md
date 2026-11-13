# Proposal

## Why

When the main agent cannot use JetBrains Central, the chat says "The model did not answer. Send the message again."
A live check on 2026-11-13 showed this text when `~/.local/bin/central` is missing (after 57 ms) and when the local
proxy of Central refuses each connection (after 1.6 s). The same text comes when the Central login has expired. In
these cases, a new message fails again, so the text sends the user into a loop. The user must know the cause and the
next step: a command in a terminal.

## What Changes

Where it shows: the chat, as the notice after a failed reply to the user. The log of the daemon already names each
failure (see the requirement "Log of a failure" of `failure-handling`), and it does not change. The task list of Air
and the commands do not change.

- **A text for each cause that Megachat can tell apart.** A failed reply on a cause of Central gives one of these
  texts in place of "The model did not answer. Send the message again.":
  - The command `~/.local/bin/central` does not exist: "Megachat cannot find the JetBrains Central CLI at
    ~/.local/bin/central. Install it, run `central login` in a terminal, and then send the message again."
  - The command `central run pi` failed, did not answer in 15 seconds, or gave a configuration that Megachat cannot
    use. An expired login gives this case: "JetBrains Central gave Megachat no configuration. Run `central login` in a
    terminal. When you are logged in, run `central repair`. Then send the message again."
  - The local proxy of Central refused the connection: "Megachat cannot connect to the local proxy of JetBrains
    Central. Run `central proxy start` or `central repair` in a terminal, and then send the message again."
  - The model request got no response for another reason, such as a reset connection: "Megachat got no response from
    JetBrains Central. Check the network, or run `central repair` in a terminal. Then send the message again."
  - Central answered the model request with the HTTP status 401 or 403: "JetBrains Central refused the request of the
    model. Your Central login can have expired. Run `central login` in a terminal, and then send the message again."
- **Other model errors keep the present text.** An HTTP status such as 429, 500 or 529, a refusal of the model and a
  failure of a summary still give "The model did not answer. Send the message again.", because a new message can work.
- **The state keeps a cause code, not a text.** The input of the failed reply gets a fixed cause code, such as
  `central_proxy`. The state still holds no error text of the provider and no output of the Central command.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `failure-handling`: the requirement "Failed reply" changes. It names the text for each cause of Central, and the
  cause code that the state keeps.

## Impact

- `src/CentralConfigurationService.mjs`: the command and the model requests record the cause of the last failure.
- `src/PiMegachatService.mjs`, `src/MegachatState.mjs`: the end of a failed reply puts the cause code on its input.
- `src/AcpBridge.mjs`: the notice of a failed reply selects the text of the cause.
- `resources/Megachat.properties`: five new texts.
- `README.md`: the requirement of a Central login names the new texts.
- `test/failure.test.mjs`, `test/integration.test.mjs`: a case for each cause.
- The change does not modify an ACP extension. The notice is a usual `agent_message_chunk`, so Air does not change.

## Out of scope

- A failed automatic turn, such as a result report or the morning report, shows no notice now, and it gets none.
- A text for a limit of the AI usage (HTTP 429) or a pointer to `central limit`.
- A check of the Central login before the first message, or at the start of the daemon.
- The texts of a failed Claude child, which already say "Central did not supply a valid local provider configuration."
- The change touches no non-goal. Megachat still installs no login service: it names the command, and the user runs
  it.
