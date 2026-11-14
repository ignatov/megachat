# Proposal

## Why

On 2026-11-14 a Claude chat in Air read the skill `air-html` and showed a dashboard in place: tiles, tabs and a table
(screenshot `AIR_Screenshot_2026-11-14_11-55-16.png`). The Megachat chat cannot do this. The user asked for the same
feature in Megachat.

A check on 2026-11-14 found how Air gives the skill:

- Air ships the skill in its bundle `ai-agent-extensions/bundledSkillsResources/com.intellij.air.backend.session.view.gui.html.AirHtmlBundledSkillsProvider/bundledSkills/air-html/SKILL.md`.
  Air copies it for each agent kind into `agents/views/<bundle>/{claude,codex,other,junie}/` (`.claude/skills/` for Claude,
  `.agents/skills/` for the others).
- Air starts its own Claude agent with `--add-dir=<cache>/agents/air-views/<bundle>/claude/<hash>` and
  `--setting-sources=user,project,local`. Claude Code reads the skills from that directory. The IDE log has the line
  `Bundled skill resolution: ... selected=[air-html]`.
- The skill is only text. It asks the agent to write an `air-html` code fence in the reply. The Air chat draws the fence
  in a sandboxed frame (no network, IDE colors, a switch to the code, an open in an editor tab). No ACP content type or
  tool is involved.
- Air also made `selected=[air-html]` for the connection of Megachat (agent kind `other`, 11:25) and wrote
  `air-views/<bundle>/other/<hash>/.agents/skills/air-html`. Megachat never reads that directory. Megachat also does
  not tell Air that it can use it: its `agentCapabilities` have no `additionalDirectories`.

So the coordinator (pi-durable) has no skill mechanism, and the Claude children do not get the directory that only the
Air session of Claude gets.

## What Changes

Where it shows: the chat of Air. The main agent can answer with an `air-html` fence, and Air draws it.

- **A copy of the skill in the instructions.** `resources/air-html.md` holds a short rules text (the fence, the rules of
  the page, when not to use it). The section is part of the instructions of the main agent only when Air supports the
  fence.
- **A check of the support.** Megachat adds the section only when `initialize` of Air offers the capability
  (decision 2 of `design.md`). Until Air names one, a setting `chat.html` (default `auto`) decides.
- **The fence passes unchanged.** The stream of the reply and the replay keep the text of the fence, also when a
  chunk ends inside the fence.
- **Results of children.** A child gets no skill. The main agent may turn a child result into a page, when the user
  asks for a visual. It does not paste a child result that it did not read.

Capabilities: modifies `chat-view` (ADDED requirement). No change in `reply-stream`, because the fence is plain text there.

ACP extension: no change of today. Possible, after the ticket: a capability name in `_meta.jetbrains.air` (see
`docs/air-contract.md`). Air must change only for that.

## Needs the Air team (ticket on IJAI, after the author says "да")

1. A capability in `_meta.jetbrains.air.capabilities` of `initialize` (for example `htmlFence`) that says "this chat
   draws `air-html`". Then an agent does not guess from the version of Air.
2. The answer to this question: does Air send the directory of `air-views/.../other/...` to a custom ACP agent
   (`additionalDirectories` in `session/new`), and may a custom agent read it?
3. A public contract of the fence (the name, the sandbox rules, the theme colors) that is not only a skill text.

## Out of scope

- Writing the HTML file to disk, a tool for it, or an editor tab.
- A skill system for the pi coordinator, or an IDE tool for children. (Non-goal: no IDE tools to children.)
- A page in a child chat. Air shows no transcript of a pi child, and a Claude child already has its own settings.
- Reading the files of the cache of Air at run time. The cache path and the hash change with each Air build.
