# Spec Delta

## MODIFIED Requirements

### Requirement: Data in the prompt
The daemon MUST collect the data, and the turn MUST get it as JSON in its prompt. With HTML in the chat on (`chat.html`), the prompt MUST ask for one `air-html` page with tiles and cards, with the kinds of money apart, and the next steps as text after the fence. Else it MUST ask for the text of three parts. Both forms MUST keep the rules of the report.

Tests: `test/morning-report.test.mjs`

#### Scenario: The prompt of the report
- **WHEN** the report of Monday 2026-11-16 starts at 09:00 UTC
- **THEN** the daemon starts one turn, and its prompt holds the data as JSON with the period from 2026-11-13 to 2026-11-15 in the timezone `UTC`

#### Scenario: The report as a page
- **WHEN** the report starts with `chat.html` `on`, or with `auto` and the Air support
- **THEN** the prompt asks for one `air-html` page, and it keeps the rules to start nothing, to name a `separateResult` task in a few words, and to say "Other work on this machine: not shown."

#### Scenario: The report as text
- **WHEN** the report starts with `chat.html` `off`, or with `auto` and no Air support
- **THEN** the prompt asks for the text of three parts, with no `air-html`, and it keeps the same rules
