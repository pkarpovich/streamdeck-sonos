import streamDeck, {
  action,
  SingletonAction,
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

  override async onWillAppear(
    ev: WillAppearEvent<SonosSettings>,
  ): Promise<void> {
    const settings = ev.payload.settings;
    const { error: initError } = await tryCatch(
      this.sonosService.initialize(settings.ipAddress, settings.deviceUuid),
    );
    if (initError) {
      streamDeck.logger.error(`Error in onWillAppear (initialize): ${initError}`);
      return;
    }

    const { error: updateError } = await tryCatch(
      this.updateButtonState(ev.action as KeyAction<SonosSettings>),
    );
    if (updateError) {
      streamDeck.logger.error(`Error in onWillAppear (updateButtonState): ${updateError}`);
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
    const { data: success, error: toggleError } = await tryCatch(
      this.sonosService.togglePlayPause(),
    );
    if (toggleError) {
      streamDeck.logger.error(`Failed to toggle playback: ${toggleError}`);
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
    const { data: playState, error: stateErr } = await tryCatch(
      this.sonosService.getPlayState(),
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

    const track = await this.sonosService.getCurrentTrack();
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
