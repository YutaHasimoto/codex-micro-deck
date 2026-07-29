# Privacy Policy — Codex Shortcuts Plugin

Effective date: Upon publication

This Stream Deck plugin runs locally on the user's Mac. The maker does not
operate a service that receives plugin data, and the plugin does not send
analytics, task content, credentials, API keys, or microphone audio to the
maker.

To display status, the plugin reads local Codex task databases and referenced
session files. These sources are read-only. It may display task titles on the
Stream Deck, but it does not write to Codex databases or session files.

When a user applies Model, Reasoning, Speed, or an Access preset, the plugin
reads and updates supported root settings in `~/.codex/config.toml`. Custom
Access reads the current values without changing that file. Stream Deck stores
plugin preferences and the plugin's local “seen” state.

While Codex is running, the plugin may communicate with same-user Codex
processes through local Unix IPC and a locally launched Codex App Server
process. These connections remain on the Mac.

The optional bundled microphone level-meter helper calculates only RMS audio
level for the touch-strip animation. It does not record, retain, transcribe, or
transmit audio. Codex itself provides dictation and transcription under
OpenAI's terms and privacy policy. Denying the helper microphone permission
only disables the live level response.

Operational logs may include an action type and a short sanitized error.
Task content, titles, IDs, task URLs, user-directory paths, and multiline
process output are excluded.

Contact: https://github.com/YutaHasimoto/codex-micro-deck/issues
Privacy URL: https://github.com/YutaHasimoto/codex-micro-deck/blob/main/marketplace/PRIVACY-en.md

Codex Shortcuts Plugin is independent third-party software by KAWAII. It is not
affiliated with, endorsed by, sponsored by, or supported by OpenAI or Elgato.
