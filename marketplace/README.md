# Marketplace Submission Kit

Draft material for submitting the plugin to the Elgato Marketplace.

## Submission fields

| Field | Value |
|---|---|
| Final product name | Codex Shortcuts Plugin |
| Maker name | KAWAII |
| Plugin UUID | `works.kawaii.codex-shortcuts-plugin` |
| Category | Development |
| Search keywords | Codex, AI coding, task status, approval, dictation, Stream Deck +, macOS |
| Support URL | https://github.com/YutaHasimoto/codex-micro-deck/issues |
| Privacy URL | https://github.com/YutaHasimoto/codex-micro-deck/blob/main/marketplace/PRIVACY-en.md |
| Product URL | https://github.com/YutaHasimoto/codex-micro-deck |
| Price | Free |
| License | KAWAII Freeware License — free use, copyright retained, redistribution prohibited |

## Files

- `LISTING-en.md`: English Marketplace copy
- `PRIVACY-en.md`: privacy disclosure
- `SUPPORT-en.md`: support page copy
- `LICENSE-ja.md`: Japanese summary of the English license
- `REVIEW-NOTES-en.md`: technical notes for reviewers
- `DEMO-SCRIPT-en.md`: short review/demo recording script
- `ASSET-CHECKLIST.md`: required listing and package assets
- `ELGATO-INQUIRY-en.md`: draft question about Japan paid sales and native
  helper signing; not sent
- `assets/app-icon-288.png`: final 288 × 288 Marketplace icon
- `assets/thumbnail-1920x960.png`: final-name illustrated thumbnail
- `assets/gallery-agent-tasks-1920x960.png`: illustrated Agent/status view
- `assets/gallery-control-dials-1920x960.png`: illustrated four-dial view
- `assets/gallery-voice-local-1920x960.png`: illustrated Voice/local-RMS view
- `assets/gallery-real-hardware-1920x960.png`: privacy-safe real Stream Deck +
  photo supplied by the maker
- `assets/demo-review-1920x1080.mp4`: 84-second silent review video with
  burned-in English captions
- `evidence/real-stream-deck-plus-scrubbed.jpg`: upright source photo with
  location, device, date, and Apple Photos metadata removed
- `evidence/current-stream-deck.jpeg`: current local proof screenshot; not a
  submission asset because it contains Japanese UI and local task labels

Before submission, resolve every `SUBMISSION BLOCKER`, verify the final identity
in the built package, host the privacy/support pages, capture the assets, and
test the exact signed package on a clean macOS user account.

## Local package candidate

- Version: `0.4.13.0`
- File: `../dist-marketplace-v0.4.13/works.kawaii.codex-shortcuts-plugin.streamDeckPlugin`
- SHA-256: `90ea169c2083272034989055b029324bb49bd18766c1a137ec5300ae35231990`
- Public package URL:
  https://github.com/YutaHasimoto/codex-micro-deck/releases/download/v0.4.13/works.kawaii.codex-shortcuts-plugin.streamDeckPlugin
- Status: built and validated locally; publication and submission pending

## Completed identity migration

- The manifest author is `KAWAII`.
- The plugin and action identifiers use the
  `works.kawaii.codex-shortcuts-plugin` namespace.
- Published plugin and action UUIDs must remain stable after first publication.

## Submission blockers

- Publish the prepared repository changes so the public product page reflects
  the final name, identity, support copy, and privacy disclosure.
- Confirm Developer ID signing/notarization expectations for the bundled native
  microphone helper. The current helper has an ad-hoc signature.
- Verify the published privacy and release-package URLs after GitHub
  publication.

## Future paid release

This submission starts as Free, so Stripe Connect availability and Japan-based
paid selling are not blockers. Before any future paid conversion, confirm
Elgato's then-current monetization-change process, Stripe Connect country
support for Japan, tax obligations, and paid-product terms.
