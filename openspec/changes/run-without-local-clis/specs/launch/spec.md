## MODIFIED Requirements

### Requirement: Agent commands
The bundle of `build.mjs` MUST NOT hold Claude, Codex, or their platform binaries. Megachat MUST start the Claude and Codex ACP agents whose commands `MEGACHAT_CLAUDE_ACP` and `MEGACHAT_CODEX_ACP` give. An IDE passes the commands of its installed agents in these variables. Each command MAY be a JSON array, a JSON object with `command`, `args`, `env`, and `cwd`, or one executable path.

Tests: `test/launch.test.mjs`, `test/bundle.test.mjs`

#### Scenario: One executable path
- **WHEN** the command is `/opt/air/claude-agent-acp`
- **THEN** Megachat starts `/opt/air/claude-agent-acp` without arguments

#### Scenario: A JSON array
- **WHEN** the command is `["/air/npx","--no","--","@agentclientprotocol/codex-acp"]`
- **THEN** Megachat starts `/air/npx` with the arguments `--no`, `--` and `@agentclientprotocol/codex-acp`

#### Scenario: A JSON object
- **WHEN** the command is `{"command":"/air/npx","args":["--no"],"env":{"A":"1"},"cwd":"/air/codex"}`
- **THEN** Megachat starts `/air/npx` with the argument `--no`, the variable `A` with the value `1`, and the working directory `/air/codex`

#### Scenario: The bundle
- **WHEN** `npm run build` makes the bundle
- **THEN** `out/bundle` holds no file of `@openai/codex`, `@openai/codex-*`, `@anthropic-ai/claude-agent-sdk-*`, `@agentclientprotocol/claude-agent-acp` or `@agentclientprotocol/codex-acp`

### Requirement: Agents that npm installed
Without `MEGACHAT_CLAUDE_ACP` and `MEGACHAT_CODEX_ACP`, Megachat MUST start the agents that npm installed with it. The module system finds them in `node_modules` of a checkout and next to an installed copy. A child MUST use the Claude Code at `~/.local/bin/claude`, and a `codex` of the `PATH` other than `bin/codex` of Megachat, when they exist. Else it MUST use the platform binary that npm installed with the agent.

Tests: `test/launch.test.mjs`, `test/package.mjs`

#### Scenario: A checkout without the variables
- **WHEN** `MEGACHAT_CLAUDE_ACP` is not set in a checkout
- **THEN** the node of Megachat starts `node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js` of the checkout

#### Scenario: An installed copy without the variables
- **WHEN** `MEGACHAT_CLAUDE_ACP` is not set in a copy that npm installed in a prefix
- **THEN** Megachat starts `node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js` of the prefix, next to the copy

#### Scenario: Claude Code of the user
- **WHEN** the home directory of the test has an executable file `.local/bin/claude`
- **THEN** the environment of a Claude child has `CLAUDE_CODE_EXECUTABLE` with the path of that file

#### Scenario: No Claude Code of the user
- **WHEN** the home directory of the test has no `.local/bin/claude`
- **THEN** the environment of a Claude child has no `CLAUDE_CODE_EXECUTABLE`, so the Claude agent starts the `claude` binary of `@anthropic-ai/claude-agent-sdk-<platform>`

#### Scenario: Codex of the user
- **WHEN** the Codex agent starts `bin/codex` with `--version`, and the `PATH` has a directory with a `codex` script that prints `user codex`
- **THEN** `bin/codex` starts that script, and the output is `user codex`

#### Scenario: No Codex of the user
- **WHEN** the Codex agent starts `bin/codex` with `--version`, and the `PATH` is `/usr/bin:/bin` with no `codex`
- **THEN** `bin/codex` starts `@openai/codex/bin/codex.js` of the Codex agent that npm installed, and the output starts with `codex-cli`

#### Scenario: A packed copy without Codex of the user
- **WHEN** npm installs the packed copy, and the `PATH` of the Codex child holds no `node_modules/.bin` and no other `codex`
- **THEN** the Codex child answers `initialize` with a protocol version

### Requirement: PATH of a child agent
The node that runs Megachat MUST come before the other directories on the `PATH` of its children. For Codex, the `bin` directory of Megachat comes before that node, because it holds the `codex` command that Central starts. The app-server of the Codex history MUST get the same `PATH` as a Codex child.

Tests: `test/launch.test.mjs`, `test/package.mjs`

#### Scenario: The PATH of a Claude child
- **WHEN** Megachat starts a Claude child
- **THEN** the first entry of the `PATH` of the child is the directory of the node that runs Megachat

#### Scenario: The PATH of a Codex child
- **WHEN** Megachat starts a Codex child through Central, and the `PATH` of Megachat is `/usr/bin`
- **THEN** the `PATH` of the child starts with the `bin` directory of Megachat, then the directory of the node that runs Megachat, and it ends with `/usr/bin`

#### Scenario: The PATH of the app-server of the Codex history
- **WHEN** Megachat starts the app-server of the Codex history, and the `PATH` of Megachat is `/usr/bin`
- **THEN** Central gets the arguments `run`, `codex`, `--`, `app-server`, `--listen` and `stdio://`, and the `PATH` starts with the `bin` directory of Megachat, then the directory of the node that runs Megachat, and it ends with `/usr/bin`

## ADDED Requirements

### Requirement: Arguments of Central for Codex
`bin/codex` MUST give Codex the arguments of Central before the arguments of the Codex ACP, because they are options of `codex`. Before the subcommand `app-server`, it MUST leave out `--profile` and its value, because Codex refuses `--profile` there. Without `central add codex`, Central passes `--profile jetbrains-central`, which only turns on the plugin of Central, and the route of Central in `-c` options, which stay.

Tests: `test/launch.test.mjs`

#### Scenario: The app-server of the Codex ACP
- **WHEN** the arguments of Central are `--profile jetbrains-central -c model_provider=jetbrains-central`, and the Codex ACP starts `bin/codex` with `app-server --listen stdio://`
- **THEN** the Codex of the user gets `-c model_provider=jetbrains-central app-server --listen stdio://`

#### Scenario: Another subcommand
- **WHEN** the arguments of Central are `--profile jetbrains-central`, and `bin/codex` gets `exec hello`
- **THEN** the Codex of the user gets `--profile jetbrains-central exec hello`
