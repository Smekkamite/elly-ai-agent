# Elly AI Bot

Elly is a Minecraft companion split into two processes:

1. `bot.js` is the Node.js brain. It reads Minecraft chat, maintains memory,
   runs deterministic goals/reflexes, and optionally uses Ollama for dialogue.
2. `Ellybridge/` is a client-side Forge mod. It exposes a loopback-only TCP
   command bridge to the local Node process and executes Minecraft actions.

The LLM is a personality and planning layer. Real-time survival, combat,
inventory, movement, and safety remain deterministic and are validated before
they reach the bridge.

## Requirements

- Node.js 20 or newer
- Minecraft 1.20.1 with Forge 47.x
- Java 17 for building the bridge
- Ollama with the configured model when `ollamaEnabled` is true
- Baritone in the Minecraft client for navigation/mining commands

## Setup

1. Copy `UI.example.json` to `UI.json` and set the Minecraft instance path and
   owner name.
2. Optionally copy `.env.example` to `.env` and load those variables in your
   preferred launcher or shell. The app does not parse `.env` automatically.
3. Install Node dependencies with `npm install`.
4. Build the Forge bridge from `Ellybridge/` using `gradlew.bat build`.
5. Install the generated bridge JAR in the bot client's `mods` directory.
6. Start Minecraft, then run `npm start`.

The bridge listens only on `127.0.0.1`. Its default port is `25580`; override
the Forge side with `-Dellybridge.port=<port>` and the Node side with
`ELLY_PORT`.

## Security model

- Only the configured owner can control Elly.
- First-message owner claiming is disabled by default. Enable it explicitly
  with `ELLY_ALLOW_OWNER_CLAIM=true` only on a trusted server.
- Protocol lines are stripped of CR/LF/NUL characters and length-limited.
- TCP timeouts close and reconnect the socket to prevent late-response desync.
- LLM commands pass through a small allowlist and argument validation.
- The bridge binds to loopback and rejects oversized commands.

Never store API keys in this directory or in filenames. If a key has ever been
saved here, revoke it at its provider; deleting a file does not revoke a key or
remove it from Git history.

## Runtime files

- `UI.json`: local configuration; ignored by Git.
- `memory.json`: mutable persistent and operational state; ignored by Git.
- `personality.json`: Elly's reviewed personality and dialogue rules.
- `UI.example.json` and `memory.example.json`: safe templates.

Invalid JSON is copied to a timestamped `.broken.*` file before a default is
created. Memory writes use a complete temporary file before replacement.
Persisted goals older than `goalResumeMaxAgeMs` (15 minutes by default) are
discarded at startup so an old route or action cannot resume unexpectedly.

## Main commands

All commands are prefixed with `@elly`:

- `help`, `status`
- `mode safe|assist|auto`
- `guard on|off|notify`
- `fight on|off|death`
- `hunt on|off`
- `pos`, `goto <x y z>`, `goto <NAME>`
- `follow <player>`, `stop`
- `mine <block> [all|N]`
- `farm [radius]`
- chest and home-area commands shown by `help`

Mining is reported as started only after a matching Baritone confirmation
appears in the Minecraft log. A Baritone parse error clears the pending goal
and is reported instead of being presented as a successful action.

## Development

```powershell
npm run check
npm test
npm run validate
```

The core parsers, memory migration, LLM-plan validation, and protocol security
rules have unit coverage. `npm run validate` checks and migrates local JSON
configuration without connecting to Minecraft. A full integration test still
requires a running Minecraft client with Elly Bridge installed.

## Source layout

- `brain/`: combat and reflex loops
- `core/`: parsers, storage, memory, paths, LLM validation, and security
- `ellyApi.js`: serialized high-level bridge API
- `tcpLineClient.js`: minimal line-based TCP transport
- `bot.js`: orchestration, deterministic commands, goals, and runtime loop
- `Ellybridge/`: Forge client bridge
