#!/bin/bash
# The setup script of Megachat. It prepares a Mac for Megachat and runs the install line. Run it in a terminal:
#
#   curl -fsSL https://github.com/ignatov/megachat/releases/latest/download/setup.sh | bash
#
# Each GitHub release has this file as an asset. The script gets git, Node.js, the Central command, the login of
# Central and the Claude key of Central, and then runs `npx -y "github:ignatov/megachat#semver:x" install`. A second
# run on a ready machine changes nothing.
#
# The texts are in this file, not in resources/Megachat.properties: the script runs before Megachat is on the machine.
# The script is for /bin/bash 3.2 of macOS. All code is in `main`, so bash runs no step before it read all of the
# script from the pipe. Each command that does not ask the user reads /dev/null, and `central login` reads the
# terminal. The script shows no output of `central status` or `central add claude-code`, because the base URL of
# Central holds a key.

set -u

# The Node.js that the script downloads when the PATH has no Node.js 22.19 or later. A constant gives the same Node.js
# to each run.
NODE_VERSION=24.22.3
NODE_MINIMUM_MAJOR=22
NODE_MINIMUM_MINOR=19
INSTALL_SPEC='github:ignatov/megachat#semver:x'
CENTRAL_INSTALLER=https://central-cli.labs.jb.gg/install.sh

say() {
  printf '[megachat setup] %s\n' "$*"
}

stop() {
  printf '[megachat setup] %s\n' "$*" >&2
  exit 1
}

# Gives 0 when the `node` of the PATH is 22.19 or later and `npx` is on the PATH.
node_is_new_enough() {
  local version major minor rest
  command -v node >/dev/null 2>&1 || return 1
  command -v npx >/dev/null 2>&1 || return 1
  version=$(node --version </dev/null 2>/dev/null) || return 1
  version=${version#v}
  case $version in
    *.*) ;;
    *) return 1 ;;
  esac
  major=${version%%.*}
  rest=${version#*.}
  minor=${rest%%.*}
  case $major in ''|*[!0-9]*) return 1 ;; esac
  case $minor in ''|*[!0-9]*) return 1 ;; esac
  [ "$major" -gt "$NODE_MINIMUM_MAJOR" ] && return 0
  [ "$major" -eq "$NODE_MINIMUM_MAJOR" ] && [ "$minor" -ge "$NODE_MINIMUM_MINOR" ]
}

# Downloads Node.js NODE_VERSION into a new temporary directory, checks the archive with SHASUMS256.txt and extracts
# it. Sets NODE_BIN to the bin directory of that Node.js. The script does not remove the directory.
download_node() {
  local architecture archive base directory expected actual
  case $(uname -m) in
    arm64) architecture=arm64 ;;
    x86_64) architecture=x64 ;;
    *) stop "Megachat has no Node.js for the processor $(uname -m). Install Node.js 22.19 or later, then run the setup line again." ;;
  esac
  archive="node-v$NODE_VERSION-darwin-$architecture.tar.gz"
  base="https://nodejs.org/dist/v$NODE_VERSION"
  directory=$(mktemp -d "${TMPDIR:-/tmp}/megachat-node.XXXXXX") || stop "Megachat cannot make a temporary directory for Node.js."
  say "The PATH has no Node.js $NODE_MINIMUM_MAJOR.$NODE_MINIMUM_MINOR or later. Megachat downloads Node.js $NODE_VERSION into $directory."
  curl -fsSL -o "$directory/$archive" "$base/$archive" </dev/null \
    || stop "The download of $base/$archive failed. Check the network, then run the setup line again."
  curl -fsSL -o "$directory/SHASUMS256.txt" "$base/SHASUMS256.txt" </dev/null \
    || stop "The download of $base/SHASUMS256.txt failed. Check the network, then run the setup line again."
  expected=$(awk -v name="$archive" '$2 == name { print $1 }' "$directory/SHASUMS256.txt")
  actual=$(shasum -a 256 "$directory/$archive" </dev/null | awk '{ print $1 }')
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    stop "The checksum of $archive is wrong, so Megachat does not use it. Run the setup line again."
  fi
  tar -xzf "$directory/$archive" -C "$directory" </dev/null || stop "Megachat cannot extract $directory/$archive."
  NODE_BIN="$directory/node-v$NODE_VERSION-darwin-$architecture/bin"
  [ -x "$NODE_BIN/npx" ] || stop "The archive $archive has no npx."
  say "The checksum of $archive is correct."
}

# Gives 0 when `central status` shows a login. Without a login, `central status` exits with 0, and a line of its
# output has "Auth" and "not connected".
central_has_login() {
  local status
  status=$("$CENTRAL" status </dev/null 2>&1) || return 1
  if printf '%s\n' "$status" | grep -q 'Auth.*not connected'; then
    return 1
  fi
  return 0
}

# Gives 0 when ~/.claude/settings.json has the Central entry of Claude Code: a key helper that calls central, and a
# base URL. `central add claude-code` writes the file and a backup at each run, so the script runs it only without
# the entry.
claude_entry_present() {
  local settings="$HOME/.claude/settings.json"
  [ -f "$settings" ] || return 1
  grep -q '"apiKeyHelper"[[:space:]]*:[[:space:]]*"[^"]*central' "$settings" || return 1
  grep -q '"ANTHROPIC_BASE_URL"' "$settings"
}

main() {
  local platform terminal acp_config npx_command npx_path code

  # 1. The platform.
  platform=$(uname -s 2>/dev/null)
  if [ "$platform" != Darwin ]; then
    stop "Megachat supports only macOS. This platform is ${platform:-unknown}."
  fi
  say "The platform is macOS."

  # 2. git. npx runs git at each start of Megachat. On macOS, /usr/bin/git fails until the Command Line Tools are
  # installed.
  if ! git --version </dev/null >/dev/null 2>&1; then
    xcode-select --install </dev/null
    stop "git is not available. Install the Command Line Tools in the dialog of macOS, then run the setup line again."
  fi
  say "git is available."

  # 3. Node.js for the install line. The IDE runs Megachat with its own Node.js.
  if node_is_new_enough; then
    npx_command=$(command -v npx)
    npx_path=$PATH
    say "The install line uses Node.js $(node --version </dev/null 2>/dev/null) from the PATH."
  else
    download_node
    npx_command="$NODE_BIN/npx"
    npx_path="$NODE_BIN:$PATH"
  fi

  # 4. The Central command.
  CENTRAL="$HOME/.local/bin/central"
  if [ ! -x "$CENTRAL" ]; then
    say "The Central command is not at $CENTRAL. Megachat runs the installer of Central from $CENTRAL_INSTALLER."
    curl -fsSL "$CENTRAL_INSTALLER" </dev/null | bash
    [ -x "$CENTRAL" ] || stop "The installer of Central did not install $CENTRAL. Install the JetBrains Central CLI, then run the setup line again."
  fi
  say "The Central command is at $CENTRAL."

  # 5. The login of Central. The standard input of this script is the pipe of curl, and `central login` needs a
  # terminal.
  if ! central_has_login; then
    terminal=${MEGACHAT_SETUP_TTY:-/dev/tty}
    if ! { : <"$terminal"; } 2>/dev/null; then
      stop "Central has no login, and Megachat cannot open the terminal $terminal for \"central login\". Run \"central login\" in a terminal, then run the setup line again."
    fi
    say "Central has no login. Log in to Central now."
    "$CENTRAL" login <"$terminal"
    central_has_login || stop "Central still has no login. Run \"$CENTRAL login\" in a terminal, then run the setup line again."
  fi
  say "Central has a login."

  # 6. The Claude key of Central. Megachat puts the directory of the Central command on the PATH of the key helper,
  # so the script changes no shell file.
  if claude_entry_present; then
    say "$HOME/.claude/settings.json has the Central entry of Claude Code."
  elif "$CENTRAL" add claude-code </dev/null >/dev/null 2>&1; then
    say "Central added its entry of Claude Code to $HOME/.claude/settings.json."
  else
    code=$?
    say "\"central add claude-code\" failed with the exit code $code. A Claude child then uses the pi route of Central. To see the reason, run \"$CENTRAL add claude-code\" in a terminal."
  fi

  # 7. An empty acp.json. The install line refuses an empty file. The file is the same as for the install line.
  acp_config=${MEGACHAT_ACP_CONFIG:-$HOME/.jetbrains/acp.json}
  if [ -f "$acp_config" ] && ! LC_ALL=C grep -q '[^[:space:]]' "$acp_config"; then
    printf '{}\n' >"$acp_config" || stop "Megachat cannot write $acp_config."
    say "$acp_config was empty. Megachat wrote {} to it."
  fi

  # 8. The install line. Its exit code is the exit code of the script.
  say "Megachat runs the install line: npx -y \"$INSTALL_SPEC\" install"
  PATH=$npx_path "$npx_command" -y "$INSTALL_SPEC" install </dev/null
  code=$?
  if [ "$code" -ne 0 ]; then
    printf '[megachat setup] %s\n' "The install line failed with the exit code $code. Read its lines above, repair the problem, then run the setup line again." >&2
    exit "$code"
  fi

  # 9. The steps in the IDE.
  say "Megachat is installed."
  say "In the IDE, select Megachat in the agent list of Air. The IDE reads the change of acp.json itself, so it needs no restart."
  say "Megachat needs an IDE build with the Air support for Megachat."
  say "The first start of Megachat in the IDE takes about 30 to 100 seconds, because npx installs the last release. Each start needs the network."
}

main "$@"
