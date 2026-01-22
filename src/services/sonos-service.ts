import { SonosDevice, SonosManager } from "@svrooij/sonos";
import { type Track, PlayMode } from "@svrooij/sonos/lib/models";
import streamDeck from "@elgato/streamdeck";
import { tryCatch } from "../utils/tryCatch";
import { discoverSonosDevices, type DiscoveredDevice } from "./discovery-service";

export type { DiscoveredDevice } from "./discovery-service";

export type CurrentTrack = {
  trackUri?: string;
  artist?: string;
  album?: string;
  title?: string;
  albumArtUrl?: string;
};

const SHUFFLE_TOGGLE_MAP: Record<string, PlayMode> = {
  NORMAL: PlayMode.ShuffleNoRepeat,
  REPEAT_ALL: PlayMode.Shuffle,
  REPEAT_ONE: PlayMode.SuffleRepeatOne,
  SHUFFLE_NOREPEAT: PlayMode.Normal,
  SHUFFLE: PlayMode.RepeatAll,
  SHUFFLE_REPEAT_ONE: PlayMode.RepeatOne,
};

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

  public getDevices(): SonosDevice[] {
    return this.manager?.Devices || [];
  }

  private async ensureInitialized(): Promise<boolean> {
    if (!this.isInitialized || !this.device) {
      return await this.initialize();
    }
    return true;
  }

  public async discoverDevices(): Promise<DiscoveredDevice[]> {
    return discoverSonosDevices();
  }

  public selectDeviceByUuid(uuid: string): boolean {
    if (!this.manager) return false;

    const device = this.manager.Devices.find((d) => d.Uuid === uuid);
    if (device) {
      this.device = device;
      streamDeck.logger.info(`Selected Sonos device: ${device.Name}`);
      return true;
    }
    return false;
  }

  public async initialize(ipAddress?: string, deviceUuid?: string): Promise<boolean> {
    if (this.isInitialized && this.device) {
      if (deviceUuid && this.device.Uuid !== deviceUuid) {
        return this.selectDeviceByUuid(deviceUuid);
      }
      return true;
    }

    this.manager = new SonosManager();

    let targetIp = ipAddress;
    if (!targetIp) {
      streamDeck.logger.info("No IP provided, discovering via mDNS...");
      const devices = await this.discoverDevices();
      const targetDevice = deviceUuid
        ? devices.find((d) => d.uuid === deviceUuid)
        : devices[0];

      if (!targetDevice) {
        streamDeck.logger.error("No Sonos devices found via mDNS");
        return false;
      }
      targetIp = targetDevice.ip;
    }

    const initResult = await tryCatch(this.manager.InitializeFromDevice(targetIp));

    if (initResult.error) {
      streamDeck.logger.error(`Failed to initialize Sonos: ${initResult.error}`);
      return false;
    }

    if (this.manager.Devices.length === 0) {
      streamDeck.logger.error("No Sonos devices found");
      return false;
    }

    if (deviceUuid) {
      this.device = this.manager.Devices.find((d) => d.Uuid === deviceUuid);
    }

    if (!this.device) {
      this.device = this.manager.Devices[0];
    }

    streamDeck.logger.info(`Connected to Sonos device: ${this.device.Name}`);
    this.isInitialized = true;
    return true;
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

  public async getCurrentTrack(): Promise<CurrentTrack | null> {
    if (!this.device) return null;

    const { data: state, error: stateError } = await tryCatch(
      this.device.GetState(),
    );
    if (stateError || !state) {
      streamDeck.logger.error(`Failed to get current track: ${stateError}`);
      return null;
    }

    const metadata = state.positionInfo.TrackMetaData as Track;
    if (!metadata) return null;

    return {
      trackUri: metadata.TrackUri,
      artist: metadata.Artist,
      album: metadata.Album,
      title: metadata.Title,
      albumArtUrl: metadata.AlbumArtUri,
    };
  }

  public async getShuffleMode(): Promise<boolean> {
    if (!(await this.ensureInitialized())) return false;

    const { data: playModeInfo, error: shuffleError } = await tryCatch(
      this.device!.AVTransportService.GetTransportSettings({
        InstanceID: 0,
      }),
    );

    if (shuffleError) {
      streamDeck.logger.error(`Failed to get shuffle state: ${shuffleError}`);
      return false;
    }

    // PlayMode can be: "NORMAL", "REPEAT_ALL", "REPEAT_ONE", "SHUFFLE_NOREPEAT", "SHUFFLE", "SHUFFLE_REPEAT_ONE"
    return playModeInfo.PlayMode.includes("SHUFFLE");
  }

  public async toggleShuffle(): Promise<boolean> {
    if (!(await this.ensureInitialized())) return false;

    const { data: settings, error: getError } = await tryCatch(
      this.device!.AVTransportService.GetTransportSettings({ InstanceID: 0 }),
    );

    if (getError) {
      streamDeck.logger.error(`Failed to get play mode: ${getError}`);
      return false;
    }

    const newMode = SHUFFLE_TOGGLE_MAP[settings.PlayMode];
    if (!newMode) {
      streamDeck.logger.error(`Unknown play mode: ${settings.PlayMode}`);
      return false;
    }

    const { error: setError } = await tryCatch(
      this.device!.AVTransportService.SetPlayMode({
        InstanceID: 0,
        NewPlayMode: newMode,
      }),
    );

    if (setError) {
      streamDeck.logger.error(`Failed to set play mode: ${setError}`);
      return false;
    }

    return true;
  }
}
