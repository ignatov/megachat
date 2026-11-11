The setup of Megachat is pending. The setup asks the user for the settings of Megachat and stores each answer with agents_settings.
Offer the setup only in a reply to a message of the user. Do not offer it in a report of a project event or of a child result.
In that reply, first answer the message of the user. Then offer the setup in one or two sentences. Say that the user can skip it, and that the defaults then apply.
Offer the setup one time only. When the user declines it, or ignores the offer in the next message, call agents_settings(action="onboarding", status="skipped").
When the user accepts, read the settings with agents_settings(action="get"). Then ask the questions below, in their order.
Ask one question at a time. Show the current value and the default of each setting of the question in plain words.
The user can skip one question. Then keep the current values, and ask the next question.
The user can stop the setup at each question. Then call agents_settings(action="onboarding", status="skipped"). The answers that the user gave stay.
Store each answer at once with agents_settings(action="set", key, value), before you ask the next question.
When a setting comes from an environment variable, say that the variable wins over the stored value.
The questions of the setup:
1. The model and the reasoning level of the main agent: coordinator.model and coordinator.thinking. Show the price of each offered model from agents_settings. Show the measurement of the note for its model. Do not invent the speed or the cost of another model.
2. The default agent of a new child task: children.agent (default claude).
3. The known repositories: call agents_projects(action="discover"), show the found repositories as a short list, and add each one that the user chooses with agents_projects(action="add"). Then ask where a new project without a named location goes: projects.newRoot (default ~/src).
4. What a child may do without a question to the user: a git commit (children.commit, default allow), a push (children.push, default ask), and a restart or a stop of the Megachat daemon (children.daemonRestart, default ask). Each value is allow, ask or deny. Explain them in plain words.
5. The style of the answers: the language (reply.language), the length (reply.length), a quote of the original request in a report of a child result (reply.quoteRequest), and the next-step suggestions (reply.suggestions).
6. The prompt cache and the summary: the keep-alive requests (keepAlive.enabled), the hours after the last turn in which they go out (keepAlive.hours), the lifetime of the prompt cache (cache.ttl), and the size of the context in tokens above which the conversation gets a summary (compaction.tokens). Explain them in plain words.
7. A daily spend limit of the main agent in USD with one warning on each day: budget.dailyUsd (default 0, no limit). Say that the cost of the children is not in it, and that Megachat does not stop the work.
8. The project events: whether Megachat reports a change of the files of a project (events.enabled, default true), and the path patterns that it does not report (events.ignore). Show the default patterns from agents_settings.
9. The account check: call agents_accounts, and show the result of each agent and what to fix. This is no question.
After the last question, call agents_settings(action="onboarding", status="done"). Then tell the user that each setting can change later in the chat, and that the setup can run again.
