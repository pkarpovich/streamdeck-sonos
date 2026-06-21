import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elgato/streamdeck", () => ({
  default: {
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
  },
}));

vi.mock("./discovery-service", () => ({
  discoverSonosDevices: vi.fn(),
}));

const sonosManagerInitSpy = vi.fn();
const sonosManagerCancelSpy = vi.fn();
const { trackToMetaDataSpy } = vi.hoisted(() => ({
  trackToMetaDataSpy: vi.fn(() => "SENTINEL_METADATA"),
}));

vi.mock("@svrooij/sonos/lib/helpers/metadata-helper", () => ({
  default: {
    TrackToMetaData: trackToMetaDataSpy,
  },
}));

vi.mock("@svrooij/sonos", () => {
  function SonosManager(this: {
    Devices: unknown[];
    InitializeFromDevice: typeof sonosManagerInitSpy;
    CancelSubscription: typeof sonosManagerCancelSpy;
  }) {
    this.Devices = [];
    this.InitializeFromDevice = sonosManagerInitSpy;
    this.CancelSubscription = sonosManagerCancelSpy;
  }
  return { SonosManager, PlayMode: {} };
});

import streamDeck from "@elgato/streamdeck";
import { discoverSonosDevices } from "./discovery-service";
import { SonosService } from "./sonos-service";

describe("SonosService.getDeviceByUuid", () => {
  let service: SonosService;
  const discoverMock = discoverSonosDevices as unknown as ReturnType<typeof vi.fn>;
  const errorMock = streamDeck.logger.error as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    discoverMock.mockReset();
    errorMock.mockReset();
    sonosManagerInitSpy.mockReset();
    sonosManagerCancelSpy.mockReset();

    service = SonosService.getInstance();
    const internal = service as unknown as {
      manager?: unknown;
      managerPromise?: unknown;
      reinitInFlight?: unknown;
      knownIps: Map<string, string>;
    };
    internal.manager = undefined;
    internal.managerPromise = undefined;
    internal.reinitInFlight = undefined;
    internal.knownIps = new Map();
  });

  it("returns device present in manager without re-discovery", async () => {
    const device = { Uuid: "RINCON_AAA", Name: "Kitchen" };
    (service as unknown as { manager: unknown }).manager = {
      Devices: [device],
      InitializeFromDevice: vi.fn(),
    };

    const result = await service.getDeviceByUuid("RINCON_AAA");

    expect(result).toBe(device);
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it("runs fresh discovery and init when uuid missing from manager but present via mDNS", async () => {
    const existing = { Uuid: "RINCON_AAA", Name: "Kitchen" };
    const target = { Uuid: "RINCON_BBB", Name: "Living" };
    const initSpy = vi.fn().mockImplementation(async () => {
      (
        service as unknown as { manager: { Devices: unknown[] } }
      ).manager.Devices.push(target);
    });
    const cancelSpy = vi.fn();
    (service as unknown as { manager: unknown }).manager = {
      Devices: [existing],
      InitializeFromDevice: initSpy,
      CancelSubscription: cancelSpy,
    };
    discoverMock.mockResolvedValue([
      { uuid: "RINCON_BBB", ip: "192.168.1.20", name: "Living" },
    ]);

    const result = await service.getDeviceByUuid("RINCON_BBB");

    expect(result).toBe(target);
    expect(initSpy).toHaveBeenCalledWith("192.168.1.20");
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(discoverMock).toHaveBeenCalledTimes(1);
  });

  it("returns null and logs when uuid missing everywhere", async () => {
    const existing = { Uuid: "RINCON_AAA", Name: "Kitchen" };
    (service as unknown as { manager: unknown }).manager = {
      Devices: [existing],
      InitializeFromDevice: vi.fn(),
    };
    discoverMock.mockResolvedValue([
      { uuid: "RINCON_AAA", ip: "192.168.1.10", name: "Kitchen" },
    ]);

    const result = await service.getDeviceByUuid("RINCON_BBB");

    expect(result).toBeNull();
    expect(errorMock).toHaveBeenCalled();
  });

  it("returns first device when no uuid is provided", async () => {
    const first = { Uuid: "RINCON_AAA", Name: "Kitchen" };
    const second = { Uuid: "RINCON_BBB", Name: "Living" };
    (service as unknown as { manager: unknown }).manager = {
      Devices: [first, second],
      InitializeFromDevice: vi.fn(),
    };

    const result = await service.getDeviceByUuid();

    expect(result).toBe(first);
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it("returns null when no uuid AND manager cannot be initialized", async () => {
    discoverMock.mockResolvedValue([]);

    const result = await service.getDeviceByUuid();

    expect(result).toBeNull();
    expect(errorMock).toHaveBeenCalled();
  });

  it("serializes concurrent slow-path re-inits", async () => {
    const existing = { Uuid: "RINCON_AAA", Name: "Kitchen" };
    const targetB = { Uuid: "RINCON_BBB", Name: "Living" };
    const initSpy = vi.fn().mockImplementation(async (ip: string) => {
      if (ip === "192.168.1.20") {
        (
          service as unknown as { manager: { Devices: unknown[] } }
        ).manager.Devices.push(targetB);
      }
    });
    const cancelSpy = vi.fn();
    (service as unknown as { manager: unknown }).manager = {
      Devices: [existing],
      InitializeFromDevice: initSpy,
      CancelSubscription: cancelSpy,
    };
    discoverMock.mockResolvedValue([
      { uuid: "RINCON_BBB", ip: "192.168.1.20", name: "Living" },
      { uuid: "RINCON_CCC", ip: "192.168.1.30", name: "Bedroom" },
    ]);

    const [resultB, resultC] = await Promise.all([
      service.getDeviceByUuid("RINCON_BBB"),
      service.getDeviceByUuid("RINCON_CCC"),
    ]);

    expect(resultB).toBe(targetB);
    expect(resultC).toBeNull();
    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to remembered IP when mDNS discovery is empty during bootstrap", async () => {
    discoverMock.mockResolvedValue([]);
    service.rememberDevice("RINCON_AAA", "192.168.1.55");

    const target = { Uuid: "RINCON_AAA", Name: "Kitchen" };
    sonosManagerInitSpy.mockImplementation(async function (
      this: { Devices: unknown[] },
    ) {
      this.Devices.push(target);
    });

    const result = await service.getDeviceByUuid("RINCON_AAA");

    expect(result).toBe(target);
    expect(sonosManagerInitSpy).toHaveBeenCalledWith("192.168.1.55");
  });

  it("returns null when both mDNS and remembered IPs are empty", async () => {
    discoverMock.mockResolvedValue([]);

    const result = await service.getDeviceByUuid();

    expect(result).toBeNull();
    expect(errorMock).toHaveBeenCalled();
    const messages = errorMock.mock.calls.map((c) => String(c[0])).join("\n");
    expect(messages).toContain("saved IPs");
  });

  it("falls back to remembered IP when mDNS misses target uuid during reinit", async () => {
    const existing = { Uuid: "RINCON_AAA", Name: "Kitchen" };
    const target = { Uuid: "RINCON_BBB", Name: "Living" };
    const initSpy = vi.fn().mockImplementation(async () => {
      (
        service as unknown as { manager: { Devices: unknown[] } }
      ).manager.Devices.push(target);
    });
    const cancelSpy = vi.fn();
    (service as unknown as { manager: unknown }).manager = {
      Devices: [existing],
      InitializeFromDevice: initSpy,
      CancelSubscription: cancelSpy,
    };
    discoverMock.mockResolvedValue([
      { uuid: "RINCON_AAA", ip: "192.168.1.10", name: "Kitchen" },
    ]);
    service.rememberDevice("RINCON_BBB", "192.168.1.99");

    const result = await service.getDeviceByUuid("RINCON_BBB");

    expect(result).toBe(target);
    expect(initSpy).toHaveBeenCalledWith("192.168.1.99");
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it("recovers from a cached manager whose Devices getter throws when empty", async () => {
    const throwingManager = {
      get Devices(): unknown[] {
        throw new Error("No Devices available!");
      },
      InitializeFromDevice: vi.fn(),
      CancelSubscription: vi.fn(),
    };
    (service as unknown as { manager: unknown }).manager = throwingManager;
    discoverMock.mockResolvedValue([]);

    const result = await service.getDeviceByUuid("RINCON_AAA");

    expect(result).toBeNull();
    expect(errorMock).toHaveBeenCalled();
  });
});

describe("SonosService favorites", () => {
  let service: SonosService;
  const discoverMock = discoverSonosDevices as unknown as ReturnType<typeof vi.fn>;
  const errorMock = streamDeck.logger.error as unknown as ReturnType<typeof vi.fn>;

  function makeCoordinator() {
    const removeAllSpy = vi.fn().mockResolvedValue(true);
    const addUriSpy = vi.fn().mockResolvedValue({
      FirstTrackNumberEnqueued: 1,
      NumTracksAdded: 1,
      NewQueueLength: 1,
    });
    const setUriSpy = vi.fn().mockResolvedValue(true);
    const switchSpy = vi.fn().mockResolvedValue(true);
    const playSpy = vi.fn().mockResolvedValue(true);

    const coordinator = {
      AVTransportService: {
        RemoveAllTracksFromQueue: removeAllSpy,
        AddURIToQueue: addUriSpy,
        SetAVTransportURI: setUriSpy,
      },
      SwitchToQueue: switchSpy,
      Play: playSpy,
    };

    return { coordinator, removeAllSpy, addUriSpy, setUriSpy, switchSpy, playSpy };
  }

  function installDevice(device: Record<string, unknown>): void {
    (service as unknown as { manager: unknown }).manager = {
      Devices: [device],
      InitializeFromDevice: vi.fn(),
    };
  }

  beforeEach(() => {
    discoverMock.mockReset();
    errorMock.mockReset();
    trackToMetaDataSpy.mockClear();

    service = SonosService.getInstance();
    const internal = service as unknown as {
      manager?: unknown;
      managerPromise?: unknown;
      reinitInFlight?: unknown;
      knownIps: Map<string, string>;
    };
    internal.manager = undefined;
    internal.managerPromise = undefined;
    internal.reinitInFlight = undefined;
    internal.knownIps = new Map();
  });

  it("playFavorite container path: clears queue, enqueues with metadata, switches, plays in order", async () => {
    const { coordinator, removeAllSpy, addUriSpy, setUriSpy, switchSpy, playSpy } =
      makeCoordinator();
    installDevice({ Uuid: "RINCON_AAA", Coordinator: coordinator });

    const favorite = {
      uri: "x-rincon-cpcontainer:1234",
      upnpClass: "object.container.playlistContainer",
      title: "My Playlist",
      albumArtUrl: "http://art",
      metadata: "DIDL_PLAYLIST",
    };

    const result = await service.playFavorite("RINCON_AAA", favorite);

    expect(result).toBe(true);
    expect(removeAllSpy).toHaveBeenCalledWith({ InstanceID: 0 });
    expect(addUriSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        EnqueuedURI: favorite.uri,
        EnqueuedURIMetaData: "DIDL_PLAYLIST",
      }),
    );
    expect(switchSpy).toHaveBeenCalledTimes(1);
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(setUriSpy).not.toHaveBeenCalled();

    const order = [
      removeAllSpy.mock.invocationCallOrder[0],
      addUriSpy.mock.invocationCallOrder[0],
      switchSpy.mock.invocationCallOrder[0],
      playSpy.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("playFavorite item path: sets transport uri with metadata then plays, no queue calls", async () => {
    const { coordinator, removeAllSpy, addUriSpy, setUriSpy, switchSpy, playSpy } =
      makeCoordinator();
    installDevice({ Uuid: "RINCON_AAA", Coordinator: coordinator });

    const favorite = {
      uri: "x-sonosapi-stream:radio",
      upnpClass: "object.item.audioItem.audioBroadcast",
      title: "Radio",
      metadata: "DIDL_RADIO",
    };

    const result = await service.playFavorite("RINCON_AAA", favorite);

    expect(result).toBe(true);
    expect(setUriSpy).toHaveBeenCalledWith({
      InstanceID: 0,
      CurrentURI: favorite.uri,
      CurrentURIMetaData: "DIDL_RADIO",
    });
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(removeAllSpy).not.toHaveBeenCalled();
    expect(addUriSpy).not.toHaveBeenCalled();
    expect(switchSpy).not.toHaveBeenCalled();
  });

  it("playFavorite returns false and logs when a transport call throws", async () => {
    const { coordinator, setUriSpy, playSpy } = makeCoordinator();
    setUriSpy.mockRejectedValue(new Error("boom"));
    installDevice({ Uuid: "RINCON_AAA", Coordinator: coordinator });

    const favorite = {
      uri: "x-sonosapi-stream:radio",
      upnpClass: "object.item.audioItem.audioBroadcast",
      title: "Radio",
      metadata: "DIDL_RADIO",
    };

    const result = await service.playFavorite("RINCON_AAA", favorite);

    expect(result).toBe(false);
    expect(errorMock).toHaveBeenCalled();
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("getFavorites maps the returned Track[] to SonosFavorite[]", async () => {
    const track = {
      TrackUri: "uri1",
      UpnpClass: "object.item.audioItem.audioBroadcast",
      Title: "Fav1",
      AlbumArtUri: "http://art1",
      CdUdn: "udn1",
    };
    const getFavoritesSpy = vi.fn().mockResolvedValue({
      Result: [track],
      NumberReturned: 1,
      TotalMatches: 1,
      UpdateID: 0,
    });
    installDevice({ Uuid: "RINCON_AAA", GetFavorites: getFavoritesSpy });

    const result = await service.getFavorites("RINCON_AAA");

    expect(result).toEqual([
      {
        uri: "uri1",
        upnpClass: "object.item.audioItem.audioBroadcast",
        title: "Fav1",
        albumArtUrl: "http://art1",
        metadata: "SENTINEL_METADATA",
      },
    ]);
    expect(trackToMetaDataSpy).toHaveBeenCalledWith(track, true, "udn1");
  });
});
