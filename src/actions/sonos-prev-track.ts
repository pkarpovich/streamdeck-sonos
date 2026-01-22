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

@action({ UUID: "com.pavel-karpovich.sonos.previous-track" })
export class SonosPreviousTrackAction extends SingletonAction<SonosSettings> {
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
    streamDeck.logger.info(`onSendToPlugin received: ${JSON.stringify(ev.payload)}`);

    if (ev.payload.action === "discover") {
      streamDeck.logger.info("Starting device discovery...");
      const devices = await this.sonosService.discoverDevices();
      streamDeck.logger.info(`Discovered ${devices.length} devices`);

      const settings = await ev.action.getSettings();

      await streamDeck.ui.sendToPropertyInspector({
        action: "deviceList",
        devices,
        selectedUuid: settings.deviceUuid,
      });
      streamDeck.logger.info("Sent deviceList to PI");
    }
  }

  override async onKeyDown(ev: KeyDownEvent<SonosSettings>): Promise<void> {
    const { data: success, error } = await tryCatch(
      this.sonosService.previousTrack(),
    );
    if (error) {
      streamDeck.logger.error(`Error in onKeyDown: ${error}`);
      return await ev.action.showAlert();
    }

    return success ? await ev.action.showOk() : await ev.action.showAlert();
  }
}
