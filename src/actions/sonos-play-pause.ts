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
import { type SonosSettings } from "../types/sonos-settings";

enum ButtonState {
  PLAYING = 1,
  PAUSED = 0,
}

@action({ UUID: "com.pavel-karpovich.sonos.playpause" })
export class SonosPlayPauseAction extends SingletonAction<SonosSettings> {
  private sonosService = SonosService.getInstance();
  private updateInterval: NodeJS.Timeout | null = null;
  private currentTrackUri: string | null = null;
  private cachedCoverUrl: string | null = null;
  private cachedCoverBase64: string | null = null;
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
    this.currentTrackUri = null;
    this.cachedCoverUrl = null;
    this.cachedCoverBase64 = null;

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
      this.sonosService.togglePlayPause(uuid),
    );
    if (toggleError) {
      streamDeck.logger.error(`Failed to toggle playback: ${toggleError}`);
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
    const { data: playState, error: stateErr } = await tryCatch(
      this.sonosService.getPlayState(uuid),
    );
    if (stateErr) {
      streamDeck.logger.error(`Failed to get play state: ${stateErr}`);
      return;
    }

    const isPlaying = playState === "PLAYING" || playState === "TRANSITIONING";
    await action.setState(isPlaying ? ButtonState.PLAYING : ButtonState.PAUSED);

    if (!isPlaying) {
      this.currentTrackUri = null;
      await action.setImage(undefined);
      return;
    }

    const track = await this.sonosService.getCurrentTrack(uuid);
    if (!track?.trackUri) return;

    const trackChanged = track.trackUri !== this.currentTrackUri;
    this.currentTrackUri = track.trackUri;

    if (!trackChanged) return;

    const coverBase64 = await this.getCoverBase64(track.albumArtUrl);
    if (coverBase64) {
      await action.setImage(coverBase64);
    }
  }

  private async getCoverBase64(url?: string): Promise<string | null> {
    if (!url) return null;
    if (url === this.cachedCoverUrl && this.cachedCoverBase64) {
      return this.cachedCoverBase64;
    }

    const { data, error } = await tryCatch(getImageAsBase64(url));
    if (error) {
      streamDeck.logger.error(`Failed to fetch cover: ${error}`);
      return null;
    }

    this.cachedCoverUrl = url;
    this.cachedCoverBase64 = data;
    return data;
  }
}
