# Proposal

## Why

The setting `projects.newRoot` names the directory where a new project without a named location goes. The default is
`~/src`. The short setup of `shorter-setup` removed its question, so a new user learns of the setting only when a
project lands in the wrong directory. The author decided on 2026-11-17: "тут надо спросить в онбординге".

## What Changes

Where it shows: the chat (the setup and the note "Welcome to Megachat") and `README.md`. No ACP extension changes, so
Air needs no change.

- **Question 4 of the setup.** After the question about the known repositories, the setup asks where new projects go.
  The reply holds the question, a numbered list of options, the current value and the default `~/src`. The first
  option is the proposed folder: the folder that the user named in question 3, when there is one, else the current
  value. The second option is the current value, when it differs. The user can also give an absolute path or a path
  that starts with `~/`. The answer goes to `agents_settings(action="set", key="projects.newRoot")` at once. When the
  user skips the question or keeps the current value, the agent stores nothing. When the tool refuses a value, the
  agent says why and asks again.
- **Four questions.** The setup rules, the note "Welcome to Megachat" and `README.md` say "four questions".
- **The grey text.** In the mode `ghost`, the likely answer of question 4 keeps the current value.

## Capabilities

### Modified Capabilities

- `settings`: "Content of the setup rules" asks for the folder of new projects as the fourth question.

## Out of scope

- No change of `projects.newRoot`, of its validation or of the action `create`.
- No new setting and no change of the offer list of `setting-offers`.
- The change `onboarding-on-open` modifies the same requirement and says "three questions" in "Setup note on its own".
  The text of the requirement here follows it. When both changes are archived, the text of this change must win.
