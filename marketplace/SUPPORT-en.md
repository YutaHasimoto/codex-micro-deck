# Support — Codex Shortcuts Plugin

Support URL: https://github.com/YutaHasimoto/codex-micro-deck/issues
Support contact: Open an issue at the Support URL. No personal email address is
required.

## Requirements

- macOS 13 or later
- Stream Deck +
- Stream Deck 7.1 or later
- Codex desktop app (`com.openai.codex`)

## First steps

1. Install the plugin and included Stream Deck + profile.
2. Start Codex and Stream Deck.
3. Select the included profile.
4. If Voice or a custom shortcut fails, enable the Stream Deck process shown by
   macOS in **System Settings > Privacy & Security > Accessibility**. Allow
   Automation access to System Events and Codex if macOS asks.
5. Microphone access for the bundled level-meter helper is optional. If denied,
   dictation can still work, but the deck uses a fallback animation.

## Troubleshooting

- If no tasks appear, confirm that Codex has local task history for the current
  macOS user.
- If settings show a warning, reopen Codex and retry. New-task defaults may
  still have been saved even when live task synchronization failed.
- If Voice stops working after a Codex update, update this plugin when a
  compatible release is available. Its UI integration depends on identifiable
  Codex accessibility controls.
- If a custom shortcut fails, check Accessibility permission and verify the
  shortcut syntax in the Property Inspector.

When requesting help, include macOS, Stream Deck, Codex, and plugin versions,
the action that failed, and the visible error. Do not send task content,
credentials, or the contents of `~/.codex`.

Codex Shortcuts Plugin is independent third-party software by KAWAII. It is not
affiliated with, endorsed by, sponsored by, or supported by OpenAI or Elgato.
