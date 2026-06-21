import streamDeck from "@elgato/streamdeck";

import { SonosPlayPauseAction } from "./actions/sonos-play-pause";
import { SonosVolumeAction } from "./actions/sonos-volume-dial";
import { SonosPreviousTrackAction } from "./actions/sonos-prev-track";
import { SonosNextTrackAction } from "./actions/sonos-next-track";
import { SonosShuffleAction } from "./actions/sonos-toggle-shuffle";
import { SonosPlayFavoriteAction } from "./actions/sonos-play-favorite";
import { SonosPlayStreamAction } from "./actions/sonos-play-stream";

streamDeck.logger.setLevel("warn");

streamDeck.actions.registerAction(new SonosPlayPauseAction());
streamDeck.actions.registerAction(new SonosVolumeAction());
streamDeck.actions.registerAction(new SonosPreviousTrackAction());
streamDeck.actions.registerAction(new SonosNextTrackAction());
streamDeck.actions.registerAction(new SonosShuffleAction());
streamDeck.actions.registerAction(new SonosPlayFavoriteAction());
streamDeck.actions.registerAction(new SonosPlayStreamAction());

streamDeck.connect();
