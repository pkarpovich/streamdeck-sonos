import streamDeck, {
  action,
  SingletonAction,
  type KeyDownEvent,
  type WillAppearEvent,
  type SendToPluginEvent,
} from "@elgato/streamdeck";
import { SonosService } from "../services/sonos-service";
import { tryCatch } from "../utils/tryCatch";
import { type SonosStreamSettings } from "../types/sonos-settings";

@action({ UUID: "com.pavel-karpovich.sonos.play-stream" })
export class SonosPlayStreamAction extends SingletonAction<SonosStreamSettings> {
  private sonosService = SonosService.getInstance();

  override async onWillAppear(
    ev: WillAppearEvent<SonosStreamSettings>,
  ): Promise<void> {
    const settings = ev.payload.settings;
    this.sonosService.rememberDevice(settings.deviceUuid, settings.ipAddress);
  }

  override async onSendToPlugin(
    ev: SendToPluginEvent<{ action: string }, SonosStreamSettings>,
  ): Promise<void> {
    if (ev.payload.action !== "discover") return;

    const settings = await ev.action.getSettings();
    const devices = await this.sonosService.discoverDevices();
    await streamDeck.ui.sendToPropertyInspector({
      action: "deviceList",
      devices,
      selectedUuid: settings.deviceUuid,
    });
  }

  override async onKeyDown(
    ev: KeyDownEvent<SonosStreamSettings>,
  ): Promise<void> {
    const settings = ev.payload.settings;
    const url = settings.streamUrl?.trim();
    if (!url) return await ev.action.showAlert();

    const { data: success, error } = await tryCatch(
      this.sonosService.playStream(settings.deviceUuid, url),
    );
    if (error) {
      streamDeck.logger.error(`Error in onKeyDown: ${error}`);
      return await ev.action.showAlert();
    }

    return success ? await ev.action.showOk() : await ev.action.showAlert();
  }
}
