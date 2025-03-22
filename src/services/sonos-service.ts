import { SonosManager, SonosDevice } from "@svrooij/sonos";
import type { Track } from "@svrooij/sonos/lib/models";
import streamDeck from "@elgato/streamdeck";
import { tryCatch } from "../utils/tryCatch";

export class SonosService {
  private manager?: SonosManager;
  private device?: SonosDevice;
  private isInitialized = false;
  private static instance: SonosService;

  private constructor() {}

  public static getInstance(): SonosService {
    if (!SonosService.instance) {
      SonosService.instance = new SonosService();
    }
    return SonosService.instance;
  }

  public getDevice(): SonosDevice | undefined {
    return this.device;
  }

  private async ensureInitialized(): Promise<boolean> {
    if (!this.isInitialized || !this.device) {
      return await this.initialize();
    }
    return true;
  }

  public async initialize(ipAddress?: string): Promise<boolean> {
    if (this.isInitialized) return true;

    this.manager = new SonosManager();
    let initResult;
    if (ipAddress) {
      initResult = await tryCatch(this.manager.InitializeFromDevice(ipAddress));
    } else {
      initResult = await tryCatch(this.manager.InitializeWithDiscovery(10));
    }
    if (initResult.error) {
      streamDeck.logger.error(
        `Failed to initialize Sonos: ${initResult.error}`,
      );
      return false;
    }

    if (this.manager.Devices.length > 0) {
      this.device =
        this.manager.Devices.find(
          (d) =>
            d.Name.toLowerCase().includes("arc") ||
            d.Name.toLowerCase().includes("sonos arc"),
        ) || this.manager.Devices[0];

      streamDeck.logger.info(`Connected to Sonos device: ${this.device.Name}`);
      this.isInitialized = true;
      return true;
    } else {
      streamDeck.logger.error("No Sonos devices found");
      return false;
    }
  }

  public async togglePlayPause(): Promise<boolean> {
    if (!(await this.ensureInitialized())) return false;
    const { error: toggleError } = await tryCatch(
      this.device!.TogglePlayback(),
    );
    if (toggleError) {
      streamDeck.logger.error(`Failed to toggle playback: ${toggleError}`);
      return false;
    }
    return true;
  }

  public async nextTrack(): Promise<boolean> {
    if (!(await this.ensureInitialized())) return false;
    const { error: nextError } = await tryCatch(this.device!.Next());
    if (nextError) {
      streamDeck.logger.error(`Failed to next track: ${nextError}`);
      return false;
    }
    return true;
  }

  public async previousTrack(): Promise<boolean> {
    if (!(await this.ensureInitialized())) return false;
    const { error: prevError } = await tryCatch(
      this.device!.AVTransportService.Previous(),
    );
    if (prevError) {
      streamDeck.logger.error(`Failed to previous track: ${prevError}`);
      return false;
    }
    return true;
  }

  public async getPlayState(): Promise<string> {
    if (!(await this.ensureInitialized())) return "STOPPED";
    const { data: transportInfo, error: playStateError } = await tryCatch(
      this.device!.AVTransportService.GetTransportInfo(),
    );
    if (playStateError) {
      streamDeck.logger.error(
        `Failed to get transport state: ${playStateError}`,
      );
      return "STOPPED";
    }
    return transportInfo.CurrentTransportState;
  }

  public async getVolume(): Promise<number> {
    if (!(await this.ensureInitialized())) return 0;
    const { data: result, error: volumeError } = await tryCatch(
      this.device!.RenderingControlService.GetVolume({
        InstanceID: 0,
        Channel: "Master",
      }),
    );
    if (volumeError) {
      streamDeck.logger.error(`Failed to get volume: ${volumeError}`);
      return 0;
    }
    return result.CurrentVolume;
  }

  public async setVolume(volume: number): Promise<boolean> {
    if (!(await this.ensureInitialized())) return false;
    const safeVolume = Math.max(0, Math.min(100, Math.round(volume)));
    const { error: setVolumeError } = await tryCatch(
      this.device!.RenderingControlService.SetVolume({
        InstanceID: 0,
        Channel: "Master",
        DesiredVolume: safeVolume,
      }),
    );
    if (setVolumeError) {
      streamDeck.logger.error(`Failed to set volume: ${setVolumeError}`);
      return false;
    }
    return true;
  }

  public async adjustVolume(adjustment: number): Promise<number> {
    const currentVolume = await this.getVolume();
    const newVolume = Math.max(0, Math.min(100, currentVolume + adjustment));
    const success = await this.setVolume(newVolume);
    return success ? newVolume : currentVolume;
  }

  public async toggleMute(): Promise<boolean> {
    if (!(await this.ensureInitialized())) return false;
    const { data: muteState, error: getMuteError } = await tryCatch(
      this.device!.RenderingControlService.GetMute({
        InstanceID: 0,
        Channel: "Master",
      }),
    );
    if (getMuteError) {
      streamDeck.logger.error(`Failed to get mute state: ${getMuteError}`);
      return false;
    }

    const { error: setMuteError } = await tryCatch(
      this.device!.RenderingControlService.SetMute({
        InstanceID: 0,
        Channel: "Master",
        DesiredMute: !muteState.CurrentMute,
      }),
    );
    if (setMuteError) {
      streamDeck.logger.error(`Failed to toggle mute: ${setMuteError}`);
      return false;
    }
    return true;
  }

  public async getMute(): Promise<boolean> {
    if (!(await this.ensureInitialized())) return false;
    const { data: result, error: muteError } = await tryCatch(
      this.device!.RenderingControlService.GetMute({
        InstanceID: 0,
        Channel: "Master",
      }),
    );
    if (muteError) {
      streamDeck.logger.error(`Failed to get mute state: ${muteError}`);
      return false;
    }
    return result.CurrentMute;
  }

  public async getTrackCover(): Promise<string | undefined> {
    if (!this.device) return "";
    const { data: state, error: stateError } = await tryCatch(
      this.device.GetState(),
    );
    if (stateError || !state) {
      streamDeck.logger.error(`Failed to get track cover: ${stateError}`);
      return "";
    }
    return (state.positionInfo.TrackMetaData as Track).AlbumArtUri;
  }
}
