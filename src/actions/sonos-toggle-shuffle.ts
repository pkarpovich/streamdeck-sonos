import streamDeck, {
  action,
  KeyDownEvent,
  SingletonAction,
  WillAppearEvent,
  KeyAction,
} from "@elgato/streamdeck";
import { SonosService } from "../services/sonos-service";
import { tryCatch } from "../utils/tryCatch";
import { type SonosSettings } from "../types/sonos-settings";

enum ButtonState {
  SHUFFLE_ON = 1,
  SHUFFLE_OFF = 0,
}

@action({ UUID: "com.pavel-karpovich.sonos.shuffle" })
export class SonosShuffleAction extends SingletonAction<SonosSettings> {
  private sonosService = SonosService.getInstance();
  private updateInterval: NodeJS.Timeout | null = null;

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

    // Update the button state every 5 seconds to reflect changes made outside the plugin
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
      this.sonosService.toggleShuffle(),
    );
    if (toggleError) {
      streamDeck.logger.error(
        `Error in onKeyDown (toggleShuffle): ${toggleError}`,
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

  override async onWillDisappear(): Promise<void> {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  private async updateButtonState(
    action: KeyAction<SonosSettings>,
  ): Promise<void> {
    const { data: shuffleEnabled, error: shuffleErr } = await tryCatch(
      this.sonosService.getShuffleMode(),
    );
    if (shuffleErr) {
      streamDeck.logger.error(
        `Error in updateButtonState (getShuffleMode): ${shuffleErr}`,
      );
      return;
    }

    const newState = shuffleEnabled
      ? ButtonState.SHUFFLE_ON
      : ButtonState.SHUFFLE_OFF;
    const { error: setStateError } = await tryCatch(action.setState(newState));
    if (setStateError) {
      streamDeck.logger.error(
        `Error in updateButtonState (setState): ${setStateError}`,
      );
    }
  }
}
