import {
  action,
  SingletonAction,
  type DialDownEvent,
  type DialRotateEvent,
  type DialUpEvent,
  type DidReceiveSettingsEvent,
  type TouchTapEvent,
  type WillAppearEvent,
  type DialAction,
  type SendToPluginEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { SonosService } from "../services/sonos-service";
import { type SonosSettings } from "../types/sonos-settings";
import { tryCatch } from "../utils/tryCatch";

type SonosVolumeSettings = SonosSettings & {
  volumeStep?: number;
};

@action({ UUID: "com.pavel-karpovich.sonos.volume" })
export class SonosVolumeAction extends SingletonAction<SonosVolumeSettings> {
  private sonosService = SonosService.getInstance();
  private volumeStep = 2;
  private updateInterval: NodeJS.Timeout | null = null;
  private lastUuid: string | undefined = undefined;

  override async onWillAppear(
    ev: WillAppearEvent<SonosVolumeSettings>,
  ): Promise<void> {
    const settings = ev.payload.settings;
    this.lastUuid = settings.deviceUuid;

    if (settings.volumeStep) {
      this.volumeStep = settings.volumeStep;
    }

    if (!ev.action.isDial()) return;

    ev.action.setFeedbackLayout("$B1");

    const { error: displayError } = await tryCatch(
      this.updateDialDisplay(
        ev.action as DialAction<SonosVolumeSettings>,
        settings.deviceUuid,
      ),
    );
    if (displayError) {
      streamDeck.logger.error(`Error in onWillAppear (updateDialDisplay): ${displayError}`);
    }

    const { error: descError } = await tryCatch(
      ev.action.setTriggerDescription({
        rotate: "Adjust Volume",
        push: "Mute / Unmute",
        touch: "Play / Pause",
        longTouch: "Reset Volume to 25%",
      }),
    );
    if (descError) {
      streamDeck.logger.error(`Error in onWillAppear (setTriggerDescription): ${descError}`);
    }

    this.updateInterval = setInterval(async () => {
      const latest = await ev.action.getSettings();
      const { error: refreshError } = await tryCatch(
        this.updateDialDisplay(
          ev.action as DialAction<SonosVolumeSettings>,
          latest.deviceUuid,
        ),
      );
      if (refreshError) {
        streamDeck.logger.error(`Error in update interval: ${refreshError}`);
      }
    }, 5000);
  }

  override async onWillDisappear(): Promise<void> {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<SonosVolumeSettings>,
  ): Promise<void> {
    const settings = ev.payload.settings;

    if (settings.volumeStep) {
      this.volumeStep = settings.volumeStep;
    }

    if (settings.deviceUuid === this.lastUuid) return;
    this.lastUuid = settings.deviceUuid;

    if (!ev.action.isDial()) return;

    const { error } = await tryCatch(
      this.updateDialDisplay(ev.action, settings.deviceUuid),
    );
    if (error) {
      streamDeck.logger.error(
        `Error in onDidReceiveSettings (updateDialDisplay): ${error}`,
      );
    }
  }

  override async onSendToPlugin(
    ev: SendToPluginEvent<{ action: string }, SonosVolumeSettings>,
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

  override async onDialRotate(
    ev: DialRotateEvent<SonosVolumeSettings>,
  ): Promise<void> {
    const adjustment = ev.payload.ticks * this.volumeStep;
    const uuid = ev.payload.settings.deviceUuid;

    const { data: newVolume, error: adjustError } = await tryCatch(
      this.sonosService.adjustVolume(uuid, adjustment),
    );
    if (adjustError) {
      streamDeck.logger.error(
        `Error in onDialRotate (adjustVolume): ${adjustError}`,
      );
      return;
    }

    const { error: displayError } = await tryCatch(
      this.updateDialDisplay(ev.action, uuid, newVolume),
    );
    if (displayError) {
      streamDeck.logger.error(
        `Error in onDialRotate (updateDialDisplay): ${displayError}`,
      );
    }
  }

  override async onDialDown(
    ev: DialDownEvent<SonosVolumeSettings>,
  ): Promise<void> {
    // We'll implement mute toggle on dial up to prevent accidental triggers
  }

  override async onDialUp(ev: DialUpEvent<SonosVolumeSettings>): Promise<void> {
    const uuid = ev.payload.settings.deviceUuid;
    const { data: success, error: toggleError } = await tryCatch(
      this.sonosService.toggleMute(uuid),
    );
    if (toggleError) {
      streamDeck.logger.error(`Error in onDialUp (toggleMute): ${toggleError}`);
      return;
    }

    if (success) {
      const { error: displayError } = await tryCatch(
        this.updateDialDisplay(ev.action, uuid),
      );
      if (displayError) {
        streamDeck.logger.error(
          `Error in onDialUp (updateDialDisplay): ${displayError}`,
        );
      }
    }
  }

  override async onTouchTap(
    ev: TouchTapEvent<SonosVolumeSettings>,
  ): Promise<void> {
    const uuid = ev.payload.settings.deviceUuid;
    const { error: toggleError } = await tryCatch(
      this.sonosService.togglePlayPause(uuid),
    );
    if (toggleError) {
      streamDeck.logger.error(
        `Error in onTouchTap (togglePlayPause): ${toggleError}`,
      );
      return;
    }

    const { error: displayError } = await tryCatch(
      this.updateDialDisplay(ev.action, uuid),
    );
    if (displayError) {
      streamDeck.logger.error(
        `Error in onTouchTap (updateDialDisplay): ${displayError}`,
      );
    }
  }

  private async updateDialDisplay(
    action: DialAction<SonosVolumeSettings>,
    uuid?: string,
    volumeOverride?: number,
  ): Promise<void> {
    const { data: volume, error: volError } = await tryCatch(
      volumeOverride !== undefined
        ? Promise.resolve(volumeOverride)
        : this.sonosService.getVolume(uuid),
    );
    if (volError) {
      streamDeck.logger.error(
        `Error in updateDialDisplay (getVolume): ${volError}`,
      );
      return;
    }

    const { data: isMuted, error: muteError } = await tryCatch(
      this.sonosService.getMute(uuid),
    );
    if (muteError) {
      streamDeck.logger.error(
        `Error in updateDialDisplay (getMute): ${muteError}`,
      );
      return;
    }

    const device = await this.sonosService.getDeviceByUuid(uuid);
    const feedback = {
      title: device?.Name ?? "Unknown Device",
      value: `${volume}%`,
      indicator: {
        value: isMuted ? 0 : volume,
      },
      icon: isMuted
        ? "imgs/actions/volume/mute_icon.svg"
        : "imgs/actions/volume/speaker_icon.svg",
    };

    const { error: setFeedbackError } = await tryCatch(
      action.setFeedback(feedback),
    );
    if (setFeedbackError) {
      streamDeck.logger.error(
        `Error in updateDialDisplay (setFeedback): ${setFeedbackError}`,
      );
    }
  }
}
