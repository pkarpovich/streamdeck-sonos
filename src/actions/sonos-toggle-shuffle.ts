import streamDeck, {
  action,
  KeyDownEvent,
  SingletonAction,
  WillAppearEvent,
  KeyAction,
  type DidReceiveSettingsEvent,
  type SendToPluginEvent,
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
  private lastUuid: string | undefined = undefined;

  override async onWillAppear(
    ev: WillAppearEvent<SonosSettings>,
  ): Promise<void> {
    this.lastUuid = ev.payload.settings.deviceUuid;

    const { error: updateError } = await tryCatch(
      this.updateButtonState(
        ev.action as KeyAction<SonosSettings>,
        ev.payload.settings.deviceUuid,
      ),
    );
    if (updateError) {
      streamDeck.logger.error(`Error in onWillAppear (updateButtonState): ${updateError}`);
    }

    this.updateInterval = setInterval(async () => {
      const settings = await ev.action.getSettings();
      const { error: refreshError } = await tryCatch(
        this.updateButtonState(
          ev.action as KeyAction<SonosSettings>,
          settings.deviceUuid,
        ),
      );
      if (refreshError) {
        streamDeck.logger.error(`Error in update interval: ${refreshError}`);
      }
    }, 5000);
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<SonosSettings>,
  ): Promise<void> {
    const uuid = ev.payload.settings.deviceUuid;
    if (uuid === this.lastUuid) return;

    this.lastUuid = uuid;

    if (!ev.action.isKey()) return;

    const { error } = await tryCatch(
      this.updateButtonState(ev.action, uuid),
    );
    if (error) {
      streamDeck.logger.error(
        `Error in onDidReceiveSettings (updateButtonState): ${error}`,
      );
    }
  }

  override async onSendToPlugin(
    ev: SendToPluginEvent<{ action: string }, SonosSettings>,
  ): Promise<void> {
    if (ev.payload.action === "discover") {
      const devices = await this.sonosService.discoverDevices();
      const settings = await ev.action.getSettings();

      await streamDeck.ui.sendToPropertyInspector({
        action: "deviceList",
        devices,
        selectedUuid: settings.deviceUuid,
      });
    }
  }

  override async onKeyDown(ev: KeyDownEvent<SonosSettings>): Promise<void> {
    const uuid = ev.payload.settings.deviceUuid;
    const { data: success, error: toggleError } = await tryCatch(
      this.sonosService.toggleShuffle(uuid),
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
        this.updateButtonState(ev.action, uuid),
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
    uuid?: string,
  ): Promise<void> {
    const { data: shuffleEnabled, error: shuffleErr } = await tryCatch(
      this.sonosService.getShuffleMode(uuid),
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
