import { SonosDevice, SonosManager } from "@svrooij/sonos";
import { type Track, PlayMode } from "@svrooij/sonos/lib/models";
import streamDeck from "@elgato/streamdeck";
import { tryCatch } from "../utils/tryCatch";
import { getImageAsBase64 } from "../utils/image";

export type CurrentPlaying = {
  id?: string;
  artist?: string;
  album?: string;
  track?: string;
  cover?: string;
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

  public async getCurrentPlaying(): Promise<CurrentPlaying | null> {
    if (!this.device) return null;
    const { data: state, error: stateError } = await tryCatch(
      this.device.GetState(),
    );
    if (stateError || !state) {
      streamDeck.logger.error(`Failed to get current playing: ${stateError}`);
      return null;
    }

    const metadata = state.positionInfo.TrackMetaData as Track;
    if (!metadata) return null;

    return {
      id: metadata.TrackUri,
      artist: metadata.Artist,
      album: metadata.Album,
      track: metadata.Title,
      cover: metadata.AlbumArtUri
        ? await getImageAsBase64(metadata.AlbumArtUri)
        : "",
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

    const { data: currentMode, error: modeError } = await tryCatch(
      this.device!.AVTransportService.GetTransportSettings({
        InstanceID: 0,
      }),
    );

    if (modeError) {
      streamDeck.logger.error(`Failed to get current play mode: ${modeError}`);
      return false;
    }

    let newMode: PlayMode;
    const currentPlayMode = currentMode.PlayMode;

    if (currentPlayMode.includes("SHUFFLE")) {
      newMode = currentPlayMode.includes("REPEAT_ONE")
        ? PlayMode.RepeatOne
        : currentPlayMode.includes("REPEAT")
          ? PlayMode.RepeatAll
          : PlayMode.Normal;
    } else {
      newMode = currentPlayMode.includes("REPEAT_ONE")
        ? PlayMode.SuffleRepeatOne
        : currentPlayMode.includes("REPEAT")
          ? PlayMode.Shuffle
          : PlayMode.ShuffleNoRepeat;
    }

    const { error: setPlayModeError } = await tryCatch(
      this.device!.AVTransportService.SetPlayMode({
        InstanceID: 0,
        NewPlayMode: newMode,
      }),
    );

    if (setPlayModeError) {
      streamDeck.logger.error(
        `Failed to toggle shuffle mode: ${setPlayModeError}`,
      );
      return false;
    }

    return true;
  }
}
