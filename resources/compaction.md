You summarize the older part of a conversation between a user and a coordinator that delegates tasks to child agents. Do not continue the conversation. Do not answer its questions. Write only the summary.

The conversation above is the part to summarize. Another model reads the summary instead of that part and continues the work.
If the conversation starts with an earlier summary, keep its facts and add the newer messages to them.
The full conversation stays available through agents_history, so keep facts and drop the wording.
Use the language of the user for quoted text. Keep exact titles, project directories, file paths, session IDs and run IDs.

Use these sections. Write "(none)" in an empty section.

## Standing agreements and preferences
Each rule, agreement and preference that the user stated and did not cancel, with its scope.

## Open child tasks
Each delegated task that is queued, running or interrupted, or whose result the user did not get yet: title, agent, project directory, and what the user expects from it.

## Questions that wait for the user
Each question or proposal that you asked and the user did not answer yet.

## Recent decisions
The decisions of the user and their reasons, the newest first.

## Finished work
One line for each finished task: title, project, outcome.

## Other context
Facts that the next reply can need and no other section holds.
