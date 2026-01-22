import streamDeck, {
  action,
  KeyDownEvent,
  SingletonAction,
  WillAppearEvent,
  type SendToPluginEvent,
} from "@elgato/streamdeck";
import { SonosService } from "../services/sonos-service";
import { tryCatch } from "../utils/tryCatch";
import { type SonosSettings } from "../types/sonos-settings";

@action({ UUID: "com.pavel-karpovich.sonos.next-track" })
export class SonosNextTrackAction extends SingletonAction<SonosSettings> {
  private sonosService = SonosService.getInstance();

  override async onWillAppear(
    ev: WillAppearEvent<SonosSettings>,
  ): Promise<void> {
    const settings = ev.payload.settings;
    const { error } = await tryCatch(
      this.sonosService.initialize(settings.ipAddress, settings.deviceUuid),
    );
    if (error) {
      streamDeck.logger.error(`Error in onWillAppear: ${error}`);
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
    const { data: success, error } = await tryCatch(
      this.sonosService.nextTrack(),
    );
    if (error) {
      streamDeck.logger.error(`Error in onKeyDown: ${error}`);
      return await ev.action.showAlert();
    }

    return success ? await ev.action.showOk() : await ev.action.showAlert();
  }
}
