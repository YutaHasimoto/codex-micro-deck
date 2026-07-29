# Marketplace Review Notes — Codex Shortcuts Plugin

Maker: KAWAII
Final plugin UUID: `works.kawaii.codex-shortcuts-plugin`
Tested package URL:
https://github.com/YutaHasimoto/codex-micro-deck/releases/download/v0.4.13/works.kawaii.codex-shortcuts-plugin.streamDeckPlugin

## Review setup

Use macOS 13+, Stream Deck 7.1+, Stream Deck +, and the Codex desktop app with
at least one local task. Install the submitted package and its included profile.
No OpenAI API key is requested or read.

## License

The plugin is distributed at no charge under the KAWAII Freeware License.
KAWAII retains copyright, and unauthorized redistribution, repackaging,
mirroring, sublicensing, and modification are prohibited. The English
`LICENSE` included in the plugin package is the controlling text. Third-party
components remain governed by the licenses identified in
`THIRD_PARTY_NOTICES.md`.

## Local data and processes

- Status is derived read-only from `~/.codex/state_5.sqlite`,
  `~/.codex/sqlite/codex-dev.db` when present, and referenced JSONL files below
  `~/.codex/sessions/`. The plugin invokes macOS `/usr/bin/sqlite3`; it never
  modifies these databases or JSONL files.
- Model choices may be read from `~/.codex/models_cache.json`.
- Applying Model, Reasoning, Speed, Ask, Delegate, or Full updates only
  supported root keys in `~/.codex/config.toml`. The write uses a temporary
  regular file and atomic rename, rejects a symbolic-link config, and preserves
  unrelated keys, comments, and tables. Custom Access is read-only.
- Stream Deck global settings store plugin configuration and local “seen”
  state.

## Local IPC and experimental interface

The plugin connects only to the same user's owner-only Unix socket at
`~/.codex/ipc/ipc.sock`. It verifies ownership, directory permissions, and that
the path is a real socket. A persistent local follower receives task and
approval state; short-lived local IPC requests send approval decisions and
settings patches. For live task settings and authoritative task names, the
plugin launches the Codex CLI App Server locally and initializes it with
`experimentalApi: true`, then stops it after the operation.

These Codex Desktop IPC, App Server experimental API, local database schemas,
and accessibility labels are not public compatibility contracts and may need a
plugin update after a Codex release. There is no maker-operated server.

## Accessibility and microphone

Accessibility/Automation is used only to operate specifically identified Codex
dictation controls and user-configured keyboard shortcuts via System Events.
Opening a task uses a `codex://threads/...` deep link. Approval and decline use
local IPC, not simulated keystrokes. Disabling accessibility control leaves
status, deep links, and configuration dials available.

The bundled native microphone helper is optional and calculates only RMS level
for the live touch-strip animation. It does not save, transcribe, or transmit
audio and exits when metering stops. Codex performs the actual dictation.

The bundled universal microphone RMS helper is ad-hoc signed because no
Developer ID Application identity is currently available. It is an optional
direct child process of the Stream Deck plugin, has no independent app bundle,
and stores or transmits no audio. It is included for Marketplace review as-is.
Please advise if a Developer ID signature or notarization is required.

## Review video

The review video is silent by design; every demonstrated step is explained with
burned-in English captions. Illustrated sequences are continuously labeled
“Illustrated feature view,” while the opening and closing shots use the supplied
real-hardware photograph.

## Full Access disclosure

The current submitted behavior exposes Ask, Delegate, Full, and Custom on the
Access dial. Full writes Codex
defaults equivalent to no approval prompts and `danger-full-access`, and sends
that setting to followed tasks for their next turn. This can allow Codex to act
outside the workspace. The deck labels the option “Full.” A key-role physical
Full action uses a second-press confirmation, but the Access dial intentionally
applies the selected value approximately 80 ms after rotation stops, including
Full, without a separate confirmation dialog. Reviewers should test Full only
in a disposable environment and return to Ask afterward. The plugin itself
does not gain macOS privileges or bypass operating-system permissions. These
notes describe the current behavior and do not promise a later functional
change.

## External data

The plugin contains no analytics, advertising, maker telemetry, or credential
collection. It makes no connection to a maker service. Codex itself may use
OpenAI services under the user's existing Codex session and OpenAI terms.

Independent third-party software by KAWAII; not affiliated with, endorsed by,
sponsored by, or supported by OpenAI or Elgato.
