import {
  action,
  SingletonAction,
  type DialDownEvent,
  type DialRotateEvent,
  type DialUpEvent,
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

  override async onWillAppear(
    ev: WillAppearEvent<SonosVolumeSettings>,
  ): Promise<void> {
    const settings = ev.payload.settings;
    const { error: initError } = await tryCatch(
      this.sonosService.initialize(settings.ipAddress, settings.deviceUuid),
    );
    if (initError) {
      streamDeck.logger.error(`Error in onWillAppear (initialize): ${initError}`);
      return;
    }

    if (settings.volumeStep) {
      this.volumeStep = settings.volumeStep;
    }

    if (!ev.action.isDial()) return;

    ev.action.setFeedbackLayout("$B1");

    const { error: displayError } = await tryCatch(
      this.updateDialDisplay(ev.action as DialAction<SonosVolumeSettings>),
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
      const { error: refreshError } = await tryCatch(
        this.updateDialDisplay(ev.action as DialAction<SonosVolumeSettings>),
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

    const { data: newVolume, error: adjustError } = await tryCatch(
      this.sonosService.adjustVolume(adjustment),
    );
    if (adjustError) {
      streamDeck.logger.error(
        `Error in onDialRotate (adjustVolume): ${adjustError}`,
      );
      return;
    }

    const { error: displayError } = await tryCatch(
      this.updateDialDisplay(ev.action, newVolume),
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
    const { data: success, error: toggleError } = await tryCatch(
      this.sonosService.toggleMute(),
    );
    if (toggleError) {
      streamDeck.logger.error(`Error in onDialUp (toggleMute): ${toggleError}`);
      return;
    }

    if (success) {
      const { error: displayError } = await tryCatch(
        this.updateDialDisplay(ev.action),
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
    const { error: toggleError } = await tryCatch(
      this.sonosService.togglePlayPause(),
    );
    if (toggleError) {
      streamDeck.logger.error(
        `Error in onTouchTap (togglePlayPause): ${toggleError}`,
      );
      return;
    }

    const { error: displayError } = await tryCatch(
      this.updateDialDisplay(ev.action),
    );
    if (displayError) {
      streamDeck.logger.error(
        `Error in onTouchTap (updateDialDisplay): ${displayError}`,
      );
    }
  }

  private async updateDialDisplay(
    action: DialAction<SonosVolumeSettings>,
    volumeOverride?: number,
  ): Promise<void> {
    const { data: volume, error: volError } = await tryCatch(
      volumeOverride !== undefined
        ? Promise.resolve(volumeOverride)
        : this.sonosService.getVolume(),
    );
    if (volError) {
      streamDeck.logger.error(
        `Error in updateDialDisplay (getVolume): ${volError}`,
      );
      return;
    }

    const { data: isMuted, error: muteError } = await tryCatch(
      this.sonosService.getMute(),
    );
    if (muteError) {
      streamDeck.logger.error(
        `Error in updateDialDisplay (getMute): ${muteError}`,
      );
      return;
    }

    const device = this.sonosService.getDevice();
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
