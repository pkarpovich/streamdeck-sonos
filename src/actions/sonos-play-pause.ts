import streamDeck, {
  action,
  SingletonAction,
  type KeyDownEvent,
  type WillAppearEvent,
  type KeyAction,
} from "@elgato/streamdeck";
import { SonosService, type CurrentPlaying } from "../services/sonos-service";
import { tryCatch } from "../utils/tryCatch";
import { type SonosSettings } from "../types/sonos-settings";

enum ButtonState {
  PLAYING = 1,
  PAUSED = 0,
}

@action({ UUID: "com.pavel-karpovich.sonos.playpause" })
export class SonosPlayPauseAction extends SingletonAction<SonosSettings> {
  private sonosService = SonosService.getInstance();
  private updateInterval: NodeJS.Timeout | null = null;
  private currentTrack: CurrentPlaying | null = null;

  override async onWillAppear(
    ev: WillAppearEvent<SonosSettings>,
  ): Promise<void> {
    const { error: initError } = await tryCatch(
      this.sonosService.initialize(ev.payload.settings.ipAddress),
    );
    if (initError) {
      streamDeck.logger.error(
        `Error in onWillAppear (initialize): ${initError}`,
      );
      return;
    }

    const { error: updateError } = await tryCatch(
      this.updateButtonState(ev.action as KeyAction<SonosSettings>),
    );
    if (updateError) {
      streamDeck.logger.error(
        `Error in onWillAppear (updateButtonState): ${updateError}`,
      );
    }

    this.updateInterval = setInterval(async () => {
      const { error: refreshError } = await tryCatch(
        this.updateButtonState(ev.action as KeyAction<SonosSettings>),
      );
      if (refreshError) {
        streamDeck.logger.error(`Error in update interval: ${refreshError}`);
      }
    }, 5000);
  }

  override async onKeyDown(ev: KeyDownEvent<SonosSettings>): Promise<void> {
    const { data: success, error: toggleError } = await tryCatch(
      this.sonosService.togglePlayPause(),
    );
    if (toggleError) {
      streamDeck.logger.error(
        `Error in onKeyDown (togglePlayPause): ${toggleError}`,
      );
      return await ev.action.showAlert();
    }
    streamDeck.logger.warn(success);

    if (success) {
      await ev.action.showOk();
      const { error: updateError } = await tryCatch(
        this.updateButtonState(ev.action),
      );
      if (updateError) {
        streamDeck.logger.error(
          `Error in onKeyDown (updateButtonState): ${updateError}`,
        );
      }
    } else {
      await ev.action.showAlert();
    }
  }

  override async onWillDisappear(): Promise<void> {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  private async updateButtonState(
    action: KeyAction<SonosSettings>,
  ): Promise<void> {
    const { data: playState, error: stateErr } = await tryCatch(
      this.sonosService.getPlayState(),
    );
    if (stateErr) {
      streamDeck.logger.error(
        `Error in updateButtonState (getPlayState): ${stateErr}`,
      );
      return;
    }

    const newState =
      playState === "PLAYING" || playState === "TRANSITIONING"
        ? ButtonState.PLAYING
        : ButtonState.PAUSED;
    const { error: setStateError } = await tryCatch(action.setState(newState));
    if (setStateError) {
      streamDeck.logger.error(
        `Error in updateButtonState (setState): ${setStateError}`,
      );
    }

    if (newState === ButtonState.PLAYING) {
      const currentTrack = await this.sonosService.getCurrentPlaying();
      if (
        currentTrack &&
        (!this.currentTrack || this.currentTrack.id !== currentTrack.id) &&
        currentTrack.cover
      ) {
        await action.setImage(currentTrack?.cover);
      }
      this.currentTrack = currentTrack;
    } else {
      await action.setImage(undefined);
    }
  }
}
