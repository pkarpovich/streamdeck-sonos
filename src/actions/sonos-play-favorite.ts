import streamDeck, {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type WillAppearEvent,
  type KeyAction,
  type SendToPluginEvent,
} from "@elgato/streamdeck";
import { SonosService } from "../services/sonos-service";
import { tryCatch } from "../utils/tryCatch";
import { getImageAsBase64 } from "../utils/image";
import { type SonosFavoriteSettings } from "../types/sonos-settings";
import { type SonosFavorite } from "../types/sonos-favorite";

@action({ UUID: "com.pavel-karpovich.sonos.favorite" })
export class SonosPlayFavoriteAction extends SingletonAction<SonosFavoriteSettings> {
  private sonosService = SonosService.getInstance();

  override async onWillAppear(
    ev: WillAppearEvent<SonosFavoriteSettings>,
  ): Promise<void> {
    const settings = ev.payload.settings;
    this.sonosService.rememberDevice(settings.deviceUuid, settings.ipAddress);
    if (!ev.action.isKey()) return;
    await this.renderCover(ev.action, settings.favorite);
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<SonosFavoriteSettings>,
  ): Promise<void> {
    const settings = ev.payload.settings;
    this.sonosService.rememberDevice(settings.deviceUuid, settings.ipAddress);
    if (!ev.action.isKey()) return;
    await this.renderCover(ev.action, settings.favorite);
  }

  override async onSendToPlugin(
    ev: SendToPluginEvent<{ action: string }, SonosFavoriteSettings>,
  ): Promise<void> {
    const settings = await ev.action.getSettings();

    if (ev.payload.action === "discover") {
      const devices = await this.sonosService.discoverDevices();
      await streamDeck.ui.sendToPropertyInspector({
        action: "deviceList",
        devices,
        selectedUuid: settings.deviceUuid,
      });
      return;
    }

    if (ev.payload.action === "loadFavorites") {
      const favorites = await this.sonosService.getFavorites(settings.deviceUuid);
      await streamDeck.ui.sendToPropertyInspector({
        action: "favoriteList",
        favorites,
        selectedUri: settings.favorite?.uri,
      });
    }
  }

  override async onKeyDown(
    ev: KeyDownEvent<SonosFavoriteSettings>,
  ): Promise<void> {
    const settings = ev.payload.settings;
    const favorite = settings.favorite;
    if (!favorite) return await ev.action.showAlert();

    const { data: success, error } = await tryCatch(
      this.sonosService.playFavorite(settings.deviceUuid, favorite),
    );
    if (error) {
      streamDeck.logger.error(`Error in onKeyDown: ${error}`);
      return await ev.action.showAlert();
    }

    return success ? await ev.action.showOk() : await ev.action.showAlert();
  }

  private async renderCover(
    action: KeyAction<SonosFavoriteSettings>,
    favorite?: SonosFavorite,
  ): Promise<void> {
    if (!favorite?.albumArtUrl) return;

    const { data, error } = await tryCatch(getImageAsBase64(favorite.albumArtUrl));
    if (error) {
      streamDeck.logger.error(`Failed to render favorite cover: ${error}`);
      return;
    }

    await action.setImage(data);
  }
}
