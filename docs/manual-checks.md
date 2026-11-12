# Manual checks

This file records the manual checks of Megachat. Each record is a measurement, not a requirement.

One manual check of `agents_steer` ran on 2026-11-12 against `@agentclientprotocol/claude-agent-acp` 0.102.0 and
`@agentclientprotocol/codex-acp` 2.6.0, with a fake main agent, the Central configuration of the children, and a new
temporary project. The task was a shell command of some seconds, then a file with the word that the user gives. A steer
in the mode `queue` gave the word during the command.

- Both `initialize` answers gave `_meta.steering.supported: true`. Both steering requests gave `injected`.
- Claude: the child wrote the steered word. The running shell tool call was not lost: it ended with `completed` after
  the full time of the command, and the next tool call wrote the file. So the Claude priority `now` did not stop the tool
  call here. The first `session/prompt` ended after the steered work, with `end_turn`.
- Codex: the child named the steered word in its reply. The first `session/prompt` ended after that reply, with
  `end_turn`. The shell tool of Codex failed on that machine, before and after the steer, so the file was not written,
  and the check could not tell whether a steer stops a running Codex tool call.
- Neither adapter gave the steered message in `session/update` on the protocol version 1: no `user_message_chunk`.
- The check did not try a steer at the end of a turn. The Codex adapter says that a turn can end before Codex reads an
  injected message, and that it then drops the message. The fake agent tests that case.

One manual check of the reply stream ran on 2026-11-12 against Claude Opus 5.5 through Central, with the reasoning level
`low` and a temporary state directory. It recorded the provider events, the partial reply in `pi.live`, the `stream`
events of the daemon and the ACP chunks. The fake API in `test/stream.test.mjs` gives the event order of the first item.

- With the display `summarized`, the thinking block opened about 1.5 s after the request, and no event followed while the
  model thought. Then the summary, the signature and the text that the model wrote in the meantime arrived in one burst:
  100 to 250 characters, or the whole reply when it was short. A reply of 121 characters arrived 30 ms before the end of
  its response, so the chat got it as one chunk. With the display `omitted`, the first burst held 3 to 6 characters, and
  the text after it came as the model wrote it.
- When the request held a tool result, Claude Opus 5.5 sent the whole text of the reply in the last 10 ms of the
  response, with each display. Claude Sonnet 5.5 did the same with the display `summarized`. Without a thinking block,
  the response itself started only at its end. A direct request through pi-ai, without Pi Durable and the daemon, gave the same result, so the cause is not in
  Megachat. Central streamed the same request for Claude Opus 5, Claude Sonnet 5 and Claude Haiku 5.5, so the cause is
  probably in the provider. It agrees with the documented change of Claude Opus 5.5 and Claude Sonnet 5.5: their text
  between tool calls becomes a thinking block, so the API cannot send a text before it knows that no tool call follows.
  So the reply after a tool call of the main agent arrives as one chunk. Each display, a request without each beta of
  pi-ai, and a request without the effort messages gave the same result.

One manual check of a Claude child with the mode `bypassPermissions` in the settings of Claude Code ran on 2026-11-12
with the adapter `@agentclientprotocol/claude-agent-acp` 0.102.0 and `children.permissionMode` `inherit`. The capability
`child-settings` gives the rule.

- With `permissions.defaultMode: "bypassPermissions"` in `~/.claude/settings.json` of the user, the Claude child started
  in the mode `default`, with no error.
- A load of a transcript in `bypassPermissions` continued in the mode `default`.
