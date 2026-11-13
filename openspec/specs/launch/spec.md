# launch Specification

## Purpose
Megachat starts the Claude and Codex ACP agents that the IDE or npm gives it, with the environment and the file mask of the user. The build in the connection file tells a client when it must replace the running daemon.

## Requirements

### Requirement: Agent commands
Megachat MUST NOT bundle Claude, Codex, or their platform binaries. It MUST start the Claude and Codex ACP agents whose commands `MEGACHAT_CLAUDE_ACP` and `MEGACHAT_CODEX_ACP` give. An IDE passes the commands of its installed agents in these variables. Each command MAY be a JSON array, a JSON object with `command`, `args`, `env`, and `cwd`, or one executable path.

Tests: `test/launch.test.mjs`

#### Scenario: One executable path
- **WHEN** the command is `/opt/air/claude-agent-acp`
- **THEN** Megachat starts `/opt/air/claude-agent-acp` without arguments

#### Scenario: A JSON array
- **WHEN** the command is `["/air/npx","--no","--","@agentclientprotocol/codex-acp"]`
- **THEN** Megachat starts `/air/npx` with the arguments `--no`, `--` and `@agentclientprotocol/codex-acp`

#### Scenario: A JSON object
- **WHEN** the command is `{"command":"/air/npx","args":["--no"],"env":{"A":"1"},"cwd":"/air/codex"}`
- **THEN** Megachat starts `/air/npx` with the argument `--no`, the variable `A` with the value `1`, and the working directory `/air/codex`

### Requirement: Agents that npm installed
Without `MEGACHAT_CLAUDE_ACP` and `MEGACHAT_CODEX_ACP`, Megachat MUST start the agents that npm installed with it. The module system finds them in `node_modules` of a checkout and next to an installed copy.

Tests: `test/launch.test.mjs`, `test/package.mjs`

#### Scenario: A checkout without the variables
- **WHEN** `MEGACHAT_CLAUDE_ACP` is not set in a checkout
- **THEN** the node of Megachat starts `node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js` of the checkout

#### Scenario: An installed copy without the variables
- **WHEN** `MEGACHAT_CLAUDE_ACP` is not set in a copy that npm installed in a prefix
- **THEN** Megachat starts `node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js` of the prefix, next to the copy

### Requirement: PATH of a child agent
The node that runs Megachat MUST come before the other directories on the `PATH` of its children. For Codex, the `bin` directory of Megachat comes before that node, because it holds the `codex` command that Central starts.

Tests: `test/launch.test.mjs`, `test/package.mjs`

#### Scenario: The PATH of a Claude child
- **WHEN** Megachat starts a Claude child
- **THEN** the first entry of the `PATH` of the child is the directory of the node that runs Megachat

#### Scenario: The PATH of a Codex child
- **WHEN** Megachat starts a Codex child through Central, and the `PATH` of Megachat is `/usr/bin`
- **THEN** the `PATH` of the child starts with the `bin` directory of Megachat, then the directory of the node that runs Megachat, and it ends with `/usr/bin`

### Requirement: File mask of a child agent
A child agent MUST get the file mask (umask) that the user had when Megachat started, so a file that a task writes gets the mode that the same agent gives it in a terminal. A daemon that `start` started MUST get that mask from `start`, not from its own mask. The daemon MUST keep the mask 077 for its own files.

Tests: `test/launch.test.mjs`

#### Scenario: A start with the mask 027
- **WHEN** the user runs `start` with the mask 027, and the Claude and Codex agents write a file
- **THEN** the files of the agents get the mode 0640, and `conversation.sqlite` of the daemon gets the mode 0600

### Requirement: Build in the connection file
The daemon MUST publish its build and a digest of the agent commands in its connection file.

Tests: `test/bundle.test.mjs`, `test/launch.test.mjs`

#### Scenario: The daemon of the bundle
- **WHEN** the bundle starts its daemon
- **THEN** the build in `daemon/connection.json` starts with the content of `build-id.txt` of the bundle and a plus sign

#### Scenario: Other agent commands
- **WHEN** a checkout gets the `MEGACHAT_CLAUDE_ACP` value `/a`, and then the value `/b`
- **THEN** the first build is `dev+` and 12 hexadecimal digits, and the second build is different

### Requirement: Replacement of a daemon
A client of another build or other agent commands MUST stop the running daemon and start its own. A client that passes no agent command MUST keep a daemon of its own build, whatever agent commands that daemon has. A source checkout MUST keep a daemon that publishes no build.

Tests: `test/launch.test.mjs`, `test/home.test.mjs`

#### Scenario: A start with other agent commands
- **WHEN** a daemon runs with the `MEGACHAT_CLAUDE_ACP` value `/air/claude-a`, and `start` gets the value `/air/claude-b`
- **THEN** a new daemon with another build starts, and the earlier daemon stops

#### Scenario: A start without agent commands
- **WHEN** a daemon runs with the `MEGACHAT_CLAUDE_ACP` value `/air/claude-a`, and `start` gets no agent command
- **THEN** the same daemon keeps running

#### Scenario: A daemon without a build
- **WHEN** a daemon publishes no build
- **THEN** a client of a source checkout keeps the daemon, and a client of the bundle replaces it

### Requirement: State check before a stop of the daemon
Before a client stops a daemon, it MUST check that it can open the state. A client that cannot MUST leave the daemon alive.

Tests: `test/home.test.mjs`

#### Scenario: A state of a newer schema version
- **WHEN** a daemon runs, the state gets the schema version of a newer build, and `start` gets other agent commands
- **THEN** `start` exits with the code 1 and says that a newer Megachat build created the state, and the daemon and its connection file stay unchanged

### Requirement: Version in the agent information
The ACP `agentInfo` MUST give the version of the build (see the requirement "Version of a build"), in a source checkout and in the bundle. The bundle MUST give the version of its checkout at the time of `npm run build`.

Tests: `test/bundle.test.mjs`, `test/recovery.test.mjs`

#### Scenario: The answer to initialize
- **WHEN** a client sends the ACP `initialize` request to `acp` of a source checkout or of the bundle
- **THEN** the `agentInfo` of the answer has the version of the build of the checkout

### Requirement: Build of a git checkout
A git checkout is a package root with a `.git` entry. Its build MUST be `dev`, so a pull keeps the running daemon.

Tests: `test/launch.test.mjs`

#### Scenario: A checkout and a worktree
- **WHEN** the package root has a `.git` directory, or a `.git` file with `gitdir: /elsewhere`
- **THEN** the build is `dev`

### Requirement: Build of a copy
A copy without `.git` MUST have a build from the version and a digest of `package.json` and of each file in `bin`, `resources` and `src`. A change of one of these files MUST change the build, so an update replaces the daemon.

Tests: `test/launch.test.mjs`, `test/package.mjs`

#### Scenario: Two equal copies
- **WHEN** two copies without `.git` have the same `package.json`, `bin`, `resources` and `src`
- **THEN** both copies have the same build, the version of `package.json` and 16 hexadecimal digits

#### Scenario: A changed file
- **WHEN** a line is added to `src/main.mjs` of a copy, and then to `resources/instructions.md`
- **THEN** each change gives a new build

#### Scenario: The daemon of an installed copy
- **WHEN** a copy that npm installed starts its daemon
- **THEN** the build in `daemon/connection.json` starts with the build of the copy, not with `dev`

### Requirement: Variables after a start by npm
When npm or npx started Megachat, the daemon and each child MUST get the environment that the IDE gives a direct command. They MUST get no variable `npm_*`, no `INIT_CWD` and no `COLOR`, and no `NODE` or `EDITOR` that npm set.

Tests: `test/environment.test.mjs`, `test/package.mjs`

#### Scenario: A daemon that npx started
- **WHEN** npx starts the daemon with `npm_execpath`, `npm_command`, `INIT_CWD`, `COLOR`, `NODE` and the `EDITOR` value `vi`
- **THEN** the daemon has none of these variables

### Requirement: Variables that the IDE adds for npx
When npm or npx started Megachat, the daemon and each child MUST get none of the variables that the IDE adds for `npx`: `NPM_CONFIG_CACHE`, `NPM_CONFIG_MIN_RELEASE_AGE`, `NPM_CONFIG_GLOBAL`, `NPM_CONFIG_DRY_RUN`, `NPM_CONFIG_INCLUDE`, `NPM_CONFIG_ENGINE_STRICT` and `NPM_CONFIG_STRICT_PEER_DEPS`.

Tests: `test/environment.test.mjs`, `test/package.mjs`

#### Scenario: An npx entry of the IDE
- **WHEN** the IDE starts the npx entry with `NPM_CONFIG_CACHE`, `NPM_CONFIG_MIN_RELEASE_AGE` set to `0`, `NPM_CONFIG_GLOBAL`, `NPM_CONFIG_DRY_RUN`, `NPM_CONFIG_INCLUDE` set to `optional`, `NPM_CONFIG_ENGINE_STRICT` and `NPM_CONFIG_STRICT_PEER_DEPS`
- **THEN** the daemon has none of these variables

### Requirement: PATH after a start by npm
When npm or npx started Megachat, the `PATH` of the daemon and of each child MUST NOT start with the `node_modules/.bin` directories and the `node-gyp-bin` directory that npm added. So a child MUST find the `codex` and the `claude` of the user, not a command in `node_modules/.bin` of the copy.

Tests: `test/environment.test.mjs`, `test/package.mjs`

#### Scenario: The PATH entries of npm
- **WHEN** npx starts the daemon with a `PATH` that starts with `_npx/0123456789abcdef/node_modules/.bin`, another `node_modules/.bin` directory and `node-gyp-bin`, before the `PATH` of the IDE
- **THEN** the `PATH` of the daemon is the `PATH` of the IDE

#### Scenario: The commands of the user
- **WHEN** the user has `codex` and `claude` on the `PATH`, and the `node_modules/.bin` directory of the npx copy holds another `codex`
- **THEN** the `codex` and the `claude` on the `PATH` of the daemon are the commands of the user

### Requirement: Kept values after a start by npm
When npm or npx started Megachat, `NODE_USE_SYSTEM_CA`, each other `NPM_CONFIG_*` variable, and each later `PATH` entry MUST stay.

Tests: `test/environment.test.mjs`, `test/package.mjs`

#### Scenario: The values of the user
- **WHEN** npx starts the daemon, and the IDE gives `NODE_USE_SYSTEM_CA` and the `NPM_CONFIG_REGISTRY` value `https://npm.example.com/`
- **THEN** the daemon keeps `NODE_USE_SYSTEM_CA` and `NPM_CONFIG_REGISTRY`

### Requirement: Environment after a direct start
A copy that Node.js started directly MUST keep its environment.

Tests: `test/environment.test.mjs`

#### Scenario: A daemon without npm_execpath
- **WHEN** the environment of the start has the variables of npm but no `npm_execpath`
- **THEN** the daemon keeps each variable and each `PATH` entry, and `codex` on its `PATH` is the `codex` of the copy

### Requirement: Version of a build
A copy without `.git`, and a git checkout at the tag `v<version>` of `package.json` with no change of a tracked file, MUST give the version of `package.json`. Another git checkout MUST add SemVer build metadata: `+<count>.g<commit>` with the count of commits after that tag, `+g<commit>` when that tag is not in its history, and `.dirty` at the end for a change of a tracked file.

Tests: `test/launch.test.mjs`

#### Scenario: A checkout at the release tag
- **WHEN** a temporary repository has the version `0.3.0` in `package.json`, its commit has the tag `v0.3.0`, and no tracked file has a change
- **THEN** the version is `0.3.0`

#### Scenario: Two commits after the release tag
- **WHEN** the same repository gets two commits after the tag `v0.3.0`
- **THEN** the version is `0.3.0+2.g` and the first 7 hexadecimal digits of the commit

#### Scenario: A changed tracked file
- **WHEN** a tracked file of the repository with two commits after the tag gets a change
- **THEN** the version is `0.3.0+2.g` and the first 7 hexadecimal digits of the commit, followed by `.dirty`

#### Scenario: A version without its tag
- **WHEN** a commit sets the version `0.4.0` in `package.json`, and the tag `v0.4.0` does not exist
- **THEN** the version is `0.4.0+g` and the first 7 hexadecimal digits of the commit

#### Scenario: A copy without .git
- **WHEN** a copy without `.git` has the version `0.3.0` in `package.json`
- **THEN** the version is `0.3.0`, and Megachat starts no git command

### Requirement: Version without an answer of git
When git fails or gives no answer in 2 seconds, a git checkout MUST give the version of `package.json` followed by `+dev`. Megachat MUST compute the version at most one time in each process.

Tests: `test/launch.test.mjs`

#### Scenario: A failed git command
- **WHEN** the package root has a `.git` file with `gitdir: /elsewhere`, and the version of `package.json` is `0.3.0`
- **THEN** the version is `0.3.0+dev`

#### Scenario: A git command without an answer
- **WHEN** the package root has a `.git` entry, and the `git` on the `PATH` gives no answer in 10 seconds
- **THEN** the version is `0.3.0+dev` after about 2 seconds

### Requirement: Version of the daemon in status
The command `status` MUST print the version of the running daemon in the key `version`, directly after the key `running`. A daemon that gives no version, such as a daemon of an earlier build, MUST give a line without the key `version`.

Tests: `test/launch.test.mjs`

#### Scenario: The status of a running daemon
- **WHEN** a daemon of a checkout runs, and the user runs `status`
- **THEN** the line has the keys `running`, `version`, `current` and `children` in this order, and `version` is the version of the build of the checkout

#### Scenario: The status of a daemon of an earlier build
- **WHEN** the `/health` answer of the daemon has no key `megachatVersion`, and the user runs `status`
- **THEN** the line is `{"running":true,"current":null,"children":[]}`
