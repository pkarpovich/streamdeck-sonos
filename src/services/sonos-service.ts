import { SonosDevice, SonosManager } from "@svrooij/sonos";
import { type Track, PlayMode } from "@svrooij/sonos/lib/models";
import axios from "axios";
import streamDeck from "@elgato/streamdeck";
import { tryCatch } from "../utils/tryCatch";
import type { SonosFavorite } from "../types/sonos-favorite";
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

const STREAM_RADIO_SCHEME = "x-rincon-mp3radio://";
const FAVORITES_CONTROL_PATH = "/MediaServer/ContentDirectory/Control";
const FAVORITES_BROWSE_ACTION =
  '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"';

function favoritesBrowseBody(): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body><u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">' +
    "<ObjectID>FV:2</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><Filter>*</Filter>" +
    "<StartingIndex>0</StartingIndex><RequestedCount>100</RequestedCount><SortCriteria></SortCriteria>" +
    "</u:Browse></s:Body></s:Envelope>"
  );
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function matchGroup(source: string, pattern: RegExp): string {
  return source.match(pattern)?.[1] ?? "";
}

async function browseFavorites(host: string): Promise<string> {
  const response = await axios.post(
    `http://${host}:1400${FAVORITES_CONTROL_PATH}`,
    favoritesBrowseBody(),
    {
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: FAVORITES_BROWSE_ACTION,
      },
      timeout: 5000,
    },
  );

  const result = matchGroup(
    response.data as string,
    /<Result>([\s\S]*?)<\/Result>/,
  );
  return result ? decodeXmlEntities(result) : "";
}

function parseFavorites(didl: string): SonosFavorite[] {
  const items = didl.match(/<item[\s\S]*?<\/item>/g) ?? [];
  const favorites: SonosFavorite[] = [];

  for (const item of items) {
    const uri = decodeXmlEntities(
      matchGroup(item, /<res[^>]*>([\s\S]*?)<\/res>/),
    );
    if (!uri) continue;

    const metadata = matchGroup(item, /<r:resMD>([\s\S]*?)<\/r:resMD>/);
    const upnpClass = matchGroup(
      decodeXmlEntities(metadata),
      /<upnp:class>([\s\S]*?)<\/upnp:class>/,
    );
    const albumArtUrl = decodeXmlEntities(
      matchGroup(item, /<upnp:albumArtURI>([\s\S]*?)<\/upnp:albumArtURI>/),
    );

    favorites.push({
      uri,
      upnpClass,
      title: decodeXmlEntities(
        matchGroup(item, /<dc:title>([\s\S]*?)<\/dc:title>/),
      ),
      albumArtUrl: albumArtUrl || undefined,
      metadata,
    });
  }

  return favorites;
}

export class SonosService {
  private manager?: SonosManager;
  private managerPromise?: Promise<SonosManager | null>;
  private reinitInFlight?: Promise<void>;
  private knownIps = new Map<string, string>();
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

  public rememberDevice(uuid?: string, ipAddress?: string): void {
    if (!uuid || !ipAddress) return;
    this.knownIps.set(uuid, ipAddress);
  }

  private async ensureManager(): Promise<SonosManager | null> {
    if (this.manager && this.hasDevices(this.manager)) {
      return this.manager;
    }
    if (!this.managerPromise) {
      this.managerPromise = this.initManager().finally(() => {
        this.managerPromise = undefined;
      });
    }
    return this.managerPromise;
  }

  private hasDevices(manager: SonosManager): boolean {
    try {
      return manager.Devices.length > 0;
    } catch {
      return false;
    }
  }

  private async initManager(): Promise<SonosManager | null> {
    const { data: devices } = await tryCatch(discoverSonosDevices());
    let seedIp = devices?.[0]?.ip;

    if (!seedIp) {
      seedIp = this.knownIps.values().next().value;
      if (seedIp) {
        streamDeck.logger.warn(
          `mDNS discovery empty, falling back to saved IP ${seedIp}`,
        );
      }
    }

    if (!seedIp) {
      streamDeck.logger.error("No Sonos devices found via mDNS or saved IPs");
      return null;
    }

    const manager = new SonosManager();
    const { error: initError } = await tryCatch(manager.InitializeFromDevice(seedIp));
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

    if (this.reinitInFlight) {
      await this.reinitInFlight;
      return manager.Devices.find((d) => d.Uuid === uuid) ?? null;
    }

    this.reinitInFlight = this.reinitForUuid(manager, uuid).finally(() => {
      this.reinitInFlight = undefined;
    });
    await this.reinitInFlight;
    return manager.Devices.find((d) => d.Uuid === uuid) ?? null;
  }

  private async reinitForUuid(manager: SonosManager, uuid: string): Promise<void> {
    const { data: devices } = await tryCatch(discoverSonosDevices());
    let targetIp = devices?.find((d) => d.uuid === uuid)?.ip;

    if (!targetIp) {
      targetIp = this.knownIps.get(uuid);
      if (targetIp) {
        streamDeck.logger.warn(
          `mDNS missing uuid ${uuid}, falling back to saved IP ${targetIp}`,
        );
      }
    }

    if (!targetIp) {
      streamDeck.logger.error(
        `Sonos device with uuid ${uuid} not found via mDNS or saved IPs`,
      );
      return;
    }

    try {
      manager.CancelSubscription();
    } catch (cancelError) {
      streamDeck.logger.error(`Failed to cancel prior subscription: ${cancelError}`);
    }

    const { error: initError } = await tryCatch(
      manager.InitializeFromDevice(targetIp),
    );
    if (initError) {
      streamDeck.logger.error(
        `Failed to initialize Sonos from ${targetIp}: ${initError}`,
      );
    }
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
    const { error } = await tryCatch(device.Previous());
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

  public async getFavorites(uuid?: string): Promise<SonosFavorite[]> {
    const device = await this.getDeviceByUuid(uuid);
    if (!device) return [];

    const { data: didl, error } = await tryCatch(browseFavorites(device.Host));
    if (error || !didl) {
      streamDeck.logger.error(`Failed to get favorites: ${error}`);
      return [];
    }

    return parseFavorites(didl);
  }

  public async playFavorite(
    uuid: string | undefined,
    favorite: SonosFavorite,
  ): Promise<boolean> {
    const device = await this.getDeviceByUuid(uuid);
    if (!device) return false;

    const coord = device.Coordinator;

    if (favorite.upnpClass.includes("audioBroadcast")) {
      const { error: setUriError } = await tryCatch(
        coord.AVTransportService.SetAVTransportURI({
          InstanceID: 0,
          CurrentURI: favorite.uri,
          CurrentURIMetaData: favorite.metadata,
        }),
      );
      if (setUriError) {
        streamDeck.logger.error(`Failed to set transport uri: ${setUriError}`);
        return false;
      }

      const { error: playError } = await tryCatch(coord.Play());
      if (playError) {
        streamDeck.logger.error(`Failed to play favorite: ${playError}`);
        return false;
      }

      return true;
    }

    const { error: clearError } = await tryCatch(
      coord.AVTransportService.RemoveAllTracksFromQueue({ InstanceID: 0 }),
    );
    if (clearError) {
      streamDeck.logger.error(`Failed to clear queue: ${clearError}`);
      return false;
    }

    const { error: enqueueError } = await tryCatch(
      coord.AVTransportService.AddURIToQueue({
        InstanceID: 0,
        EnqueuedURI: favorite.uri,
        EnqueuedURIMetaData: favorite.metadata,
        DesiredFirstTrackNumberEnqueued: 0,
        EnqueueAsNext: false,
      }),
    );
    if (enqueueError) {
      streamDeck.logger.error(`Failed to enqueue favorite: ${enqueueError}`);
      return false;
    }

    const { error: switchError } = await tryCatch(coord.SwitchToQueue());
    if (switchError) {
      streamDeck.logger.error(`Failed to switch to queue: ${switchError}`);
      return false;
    }

    const { error: playError } = await tryCatch(coord.Play());
    if (playError) {
      streamDeck.logger.error(`Failed to play favorite: ${playError}`);
      return false;
    }

    return true;
  }

  public async playStream(
    uuid: string | undefined,
    url: string,
  ): Promise<boolean> {
    const device = await this.getDeviceByUuid(uuid);
    if (!device) return false;

    const coord = device.Coordinator;
    const streamUri = url.startsWith(STREAM_RADIO_SCHEME)
      ? url
      : `${STREAM_RADIO_SCHEME}${url}`;

    const { error: setUriError } = await tryCatch(
      coord.AVTransportService.SetAVTransportURI({
        InstanceID: 0,
        CurrentURI: streamUri,
        CurrentURIMetaData: "",
      }),
    );
    if (setUriError) {
      streamDeck.logger.error(`Failed to set stream uri: ${setUriError}`);
      return false;
    }

    const { error: playError } = await tryCatch(coord.Play());
    if (playError) {
      streamDeck.logger.error(`Failed to play stream: ${playError}`);
      return false;
    }

    return true;
  }
}
