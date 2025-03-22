import streamDeck, {
  action,
  KeyDownEvent,
  SingletonAction,
  WillAppearEvent,
} from "@elgato/streamdeck";
import { SonosService } from "../services/sonos-service";
import { tryCatch } from "../utils/tryCatch";
import { type SonosSettings } from "../types/sonos-settings";

@action({ UUID: "com.pavel-karpovich.sonos.playpause" })
export class SonosPlayPauseAction extends SingletonAction<SonosSettings> {
  private sonosService = SonosService.getInstance();

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
      this.updateButtonState(ev.action),
    );
    if (updateError) {
      streamDeck.logger.error(
        `Error in onWillAppear (updateButtonState): ${updateError}`,
      );
    }
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

  private async updateButtonState(action: any): Promise<void> {
    const { data: playState, error } = await tryCatch(
      this.sonosService.getPlayState(),
    );
    if (error) {
      streamDeck.logger.error(
        `Error in updateButtonState (getPlayState): ${error}`,
      );
      return;
    }

    const newState = playState === "PLAYING" ? 1 : 0;
    const { error: setStateError } = await tryCatch(action.setState(newState));
    if (setStateError) {
      streamDeck.logger.error(
        `Error in updateButtonState (setState): ${setStateError}`,
      );
    }
  }
}
