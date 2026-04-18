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
  private static instance: SonosService;

  private constructor() {}

  public static getInstance(): SonosService {
    if (!SonosService.instance) {
      SonosService.instance = new SonosService();
    }
    return SonosService.instance;
  }

  public async discoverDevices(): Promise<DiscoveredDevice[]> {
    return discoverSonosDevices();
  }

  private async ensureManager(seedIp?: string): Promise<SonosManager | null> {
    if (this.manager && this.manager.Devices.length > 0) {
      return this.manager;
    }

    let targetIp = seedIp;
    if (!targetIp) {
      const { data: devices, error } = await tryCatch(discoverSonosDevices());
      if (error) {
        streamDeck.logger.error(`Failed to discover Sonos devices: ${error}`);
        return null;
      }
      if (!devices || devices.length === 0) {
        streamDeck.logger.error("No Sonos devices found via mDNS");
        return null;
      }
      targetIp = devices[0].ip;
    }

    const manager = new SonosManager();
    const { error: initError } = await tryCatch(manager.InitializeFromDevice(targetIp));
    if (initError) {
      streamDeck.logger.error(`Failed to initialize Sonos manager: ${initError}`);
      return null;
    }

    this.manager = manager;
    return this.manager;
  }

  public async getDeviceByUuid(uuid?: string): Promise<SonosDevice | null> {
    const manager = await this.ensureManager();
    if (!manager) return null;

    if (!uuid) {
      return manager.Devices[0] ?? null;
    }

    const existing = manager.Devices.find((d) => d.Uuid === uuid);
    if (existing) return existing;

    const { data: devices, error } = await tryCatch(discoverSonosDevices());
    if (error) {
      streamDeck.logger.error(`Failed fresh discovery for uuid ${uuid}: ${error}`);
      return null;
    }
    const match = devices?.find((d) => d.uuid === uuid);
    if (!match) {
      streamDeck.logger.error(`Sonos device with uuid ${uuid} not found`);
      return null;
    }

    const { error: initError } = await tryCatch(
      manager.InitializeFromDevice(match.ip),
    );
    if (initError) {
      streamDeck.logger.error(
        `Failed to initialize Sonos from ${match.ip}: ${initError}`,
      );
      return null;
    }

    return manager.Devices.find((d) => d.Uuid === uuid) ?? null;
  }

  public async togglePlayPause(uuid?: string): Promise<boolean> {
    const device = await this.getDeviceByUuid(uuid);
    if (!device) return false;
    const { error } = await tryCatch(device.TogglePlayback());
    if (error) {
      streamDeck.logger.error(`Failed to toggle playback: ${error}`);
      return false;
    }
    return true;
  }

  public async nextTrack(uuid?: string): Promise<boolean> {
    const device = await this.getDeviceByUuid(uuid);
    if (!device) return false;
    const { error } = await tryCatch(device.Next());
    if (error) {
      streamDeck.logger.error(`Failed to next track: ${error}`);
      return false;
    }
    return true;
  }

  public async previousTrack(uuid?: string): Promise<boolean> {
    const device = await this.getDeviceByUuid(uuid);
    if (!device) return false;
    const { error } = await tryCatch(device.AVTransportService.Previous());
    if (error) {
      streamDeck.logger.error(`Failed to previous track: ${error}`);
      return false;
    }
    return true;
  }

  public async getPlayState(uuid?: string): Promise<string> {
    const device = await this.getDeviceByUuid(uuid);
    if (!device) return "STOPPED";
    const { data: transportInfo, error } = await tryCatch(
      device.AVTransportService.GetTransportInfo(),
    );
    if (error) {
      streamDeck.logger.error(`Failed to get transport state: ${error}`);
      return "STOPPED";
    }
    return transportInfo.CurrentTransportState;
  }

  public async getVolume(uuid?: string): Promise<number> {
    const device = await this.getDeviceByUuid(uuid);
    if (!device) return 0;
    const { data: result, error } = await tryCatch(
      device.RenderingControlService.GetVolume({
        InstanceID: 0,
        Channel: "Master",
      }),
    );
    if (error) {
      streamDeck.logger.error(`Failed to get volume: ${error}`);
      return 0;
    }
    return result.CurrentVolume;
  }

  public async setVolume(uuid: string | undefined, volume: number): Promise<boolean> {
    const device = await this.getDeviceByUuid(uuid);
    if (!device) return false;
    const safeVolume = Math.max(0, Math.min(100, Math.round(volume)));
    const { error } = await tryCatch(
      device.RenderingControlService.SetVolume({
        InstanceID: 0,
        Channel: "Master",
        DesiredVolume: safeVolume,
      }),
    );
    if (error) {
      streamDeck.logger.error(`Failed to set volume: ${error}`);
      return false;
    }
    return true;
  }

  public async adjustVolume(uuid: string | undefined, adjustment: number): Promise<number> {
    const currentVolume = await this.getVolume(uuid);
    const newVolume = Math.max(0, Math.min(100, currentVolume + adjustment));
    const success = await this.setVolume(uuid, newVolume);
    return success ? newVolume : currentVolume;
  }

  public async toggleMute(uuid?: string): Promise<boolean> {
    const device = await this.getDeviceByUuid(uuid);
    if (!device) return false;
    const { data: muteState, error: getMuteError } = await tryCatch(
      device.RenderingControlService.GetMute({
        InstanceID: 0,
        Channel: "Master",
      }),
    );
    if (getMuteError) {
      streamDeck.logger.error(`Failed to get mute state: ${getMuteError}`);
      return false;
    }

    const { error: setMuteError } = await tryCatch(
      device.RenderingControlService.SetMute({
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

  public async getMute(uuid?: string): Promise<boolean> {
    const device = await this.getDeviceByUuid(uuid);
    if (!device) return false;
    const { data: result, error } = await tryCatch(
      device.RenderingControlService.GetMute({
        InstanceID: 0,
        Channel: "Master",
      }),
    );
    if (error) {
      streamDeck.logger.error(`Failed to get mute state: ${error}`);
      return false;
    }
    return result.CurrentMute;
  }

  public async getCurrentTrack(uuid?: string): Promise<CurrentTrack | null> {
    const device = await this.getDeviceByUuid(uuid);
    if (!device) return null;

    const { data: state, error } = await tryCatch(device.GetState());
    if (error || !state) {
      streamDeck.logger.error(`Failed to get current track: ${error}`);
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

  public async getShuffleMode(uuid?: string): Promise<boolean> {
    const device = await this.getDeviceByUuid(uuid);
    if (!device) return false;

    const { data: playModeInfo, error } = await tryCatch(
      device.AVTransportService.GetTransportSettings({
        InstanceID: 0,
      }),
    );

    if (error) {
      streamDeck.logger.error(`Failed to get shuffle state: ${error}`);
      return false;
    }

    return playModeInfo.PlayMode.includes("SHUFFLE");
  }

  public async toggleShuffle(uuid?: string): Promise<boolean> {
    const device = await this.getDeviceByUuid(uuid);
    if (!device) return false;

    const { data: settings, error: getError } = await tryCatch(
      device.AVTransportService.GetTransportSettings({ InstanceID: 0 }),
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
      device.AVTransportService.SetPlayMode({
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
