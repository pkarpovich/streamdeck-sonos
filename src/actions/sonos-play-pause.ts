import streamDeck, {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
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
  private updateIntervals = new Map<string, NodeJS.Timeout>();
  private currentTrackUris = new Map<string, string | null>();
  private cachedCoverUrls = new Map<string, string | null>();
  private cachedCoverBase64s = new Map<string, string | null>();
  private lastUuids = new Map<string, string | undefined>();

  override async onWillAppear(
    ev: WillAppearEvent<SonosSettings>,
  ): Promise<void> {
    const settings = ev.payload.settings;
    const actionId = ev.action.id;
    this.lastUuids.set(actionId, settings.deviceUuid);
    this.sonosService.rememberDevice(settings.deviceUuid, settings.ipAddress);

    const { error: updateError } = await tryCatch(
      this.updateButtonState(
        ev.action as KeyAction<SonosSettings>,
        settings.deviceUuid,
      ),
    );
    if (updateError) {
      streamDeck.logger.error(`Error in onWillAppear (updateButtonState): ${updateError}`);
    }

    const existing = this.updateIntervals.get(actionId);
    if (existing) clearInterval(existing);

    const interval = setInterval(async () => {
      const latest = await ev.action.getSettings();
      const { error: refreshError } = await tryCatch(
        this.updateButtonState(
          ev.action as KeyAction<SonosSettings>,
          latest.deviceUuid,
        ),
      );
      if (refreshError) {
        streamDeck.logger.error(`Error in update interval: ${refreshError}`);
      }
    }, 5000);
    this.updateIntervals.set(actionId, interval);
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<SonosSettings>,
  ): Promise<void> {
    const settings = ev.payload.settings;
    const uuid = settings.deviceUuid;
    const actionId = ev.action.id;
    this.sonosService.rememberDevice(uuid, settings.ipAddress);

    const previousUuid = this.lastUuids.get(actionId);
    if (this.lastUuids.has(actionId) && uuid === previousUuid) return;

    this.lastUuids.set(actionId, uuid);
    this.currentTrackUris.delete(actionId);
    this.cachedCoverUrls.delete(actionId);
    this.cachedCoverBase64s.delete(actionId);

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

  override async onWillDisappear(
    ev: WillDisappearEvent<SonosSettings>,
  ): Promise<void> {
    const actionId = ev.action.id;
    this.lastUuids.delete(actionId);
    this.currentTrackUris.delete(actionId);
    this.cachedCoverUrls.delete(actionId);
    this.cachedCoverBase64s.delete(actionId);

    const interval = this.updateIntervals.get(actionId);
    if (interval) {
      clearInterval(interval);
      this.updateIntervals.delete(actionId);
    }
  }

  private async updateButtonState(
    action: KeyAction<SonosSettings>,
    uuid?: string,
  ): Promise<void> {
    const actionId = action.id;
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
      this.currentTrackUris.set(actionId, null);
      await action.setImage(undefined);
      return;
    }

    const track = await this.sonosService.getCurrentTrack(uuid);
    if (!track?.trackUri) return;

    const previousTrackUri = this.currentTrackUris.get(actionId) ?? null;
    const trackChanged = track.trackUri !== previousTrackUri;
    this.currentTrackUris.set(actionId, track.trackUri);

    if (!trackChanged) return;

    const coverBase64 = await this.getCoverBase64(actionId, track.albumArtUrl);
    if (coverBase64) {
      await action.setImage(coverBase64);
    }
  }

  private async getCoverBase64(
    actionId: string,
    url?: string,
  ): Promise<string | null> {
    if (!url) return null;
    const cachedUrl = this.cachedCoverUrls.get(actionId);
    const cachedBase64 = this.cachedCoverBase64s.get(actionId);
    if (url === cachedUrl && cachedBase64) {
      return cachedBase64;
    }

    const { data, error } = await tryCatch(getImageAsBase64(url));
    if (error) {
      streamDeck.logger.error(`Failed to fetch cover: ${error}`);
      return null;
    }

    this.cachedCoverUrls.set(actionId, url);
    this.cachedCoverBase64s.set(actionId, data);
    return data;
  }
}
