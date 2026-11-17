# Design

## Context

The setup rules are the text `resources/instructions-onboarding.md`. The main agent follows them with the tools
`agents_settings` and `agents_projects`. No code drives the questions, so the change is a text change with tests that
read the text. `settings.json` gets no new field: `projects.newRoot` is a setting of today.

## Decisions

### 1. Place

The question is number 4, after the known repositories. Question 3 can give a folder that the user named, such as
`~/dev`, and question 4 can then propose it. A user who skips question 3 gets the current value as the proposal.

### 2. Proposal

The proposal is the named folder of question 3, else the current value of `projects.newRoot`. The agent does not add
a folder to the list of known repositories for this question, and it does not make the folder: `create` makes it when
a project comes.

### 3. Skip and refusal

A skip, "keep" or the current value stores nothing, as for each other question. A refusal of the tool, for a relative
path or a hidden or foreign directory, goes to the user in plain words, and the agent asks the question again.

### 4. Texts

`onboarding.offer` in `resources/Megachat.properties` says "four short questions" and adds where new projects go. The
ghost rules keep the current value as the likely answer.
