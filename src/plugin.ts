import streamDeck from "@elgato/streamdeck";

import { CodexEncoderAction } from "./actions/encoder-action.js";
import { CodexKeyAction } from "./actions/key-action.js";
import { CodexAppServerClient } from "./codex/app-server-client.js";
import { CodexDesktopFollower } from "./codex/desktop-follower.js";
import { CodexDeckCoordinator } from "./coordinator.js";
import type { GlobalSettings } from "./types.js";

// Keep name discovery in its own isolated child. The settings-sync App Server
// owned by the coordinator still starts/stops only for a control apply.
const coordinator = new CodexDeckCoordinator({
  threadNames: new CodexAppServerClient(),
  follower: new CodexDesktopFollower({
    logger: (message) => streamDeck.logger.info(message)
  })
});

streamDeck.logger.setLevel("info");
streamDeck.actions.registerAction(new CodexKeyAction(coordinator));
streamDeck.actions.registerAction(new CodexEncoderAction(coordinator));

streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((event) => {
  coordinator.configure(event.settings, persistGlobalSettings);
});

// Stream Deck 7.1+ tags getSettings/getGlobalSettings responses with request
// identifiers. Without this mode, an internal refresh response is emitted as
// didReceiveSettings and cancels the dial's pending trailing auto-apply.
streamDeck.settings.useExperimentalMessageIdentifiers = true;
await streamDeck.connect();
const globalSettings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
coordinator.configure(globalSettings, persistGlobalSettings);
coordinator.start();

async function persistGlobalSettings(settings: GlobalSettings): Promise<void> {
  await streamDeck.settings.setGlobalSettings(settings);
}
