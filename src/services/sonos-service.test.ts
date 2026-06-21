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
const { axiosPostSpy } = vi.hoisted(() => ({ axiosPostSpy: vi.fn() }));

vi.mock("axios", () => ({
  default: { post: axiosPostSpy },
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
    axiosPostSpy.mockReset();

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

  it("playFavorite broadcast path: sets transport uri with metadata then plays, no queue calls", async () => {
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

  it("playFavorite track path: non-broadcast item is enqueued, not set as transport uri", async () => {
    const { coordinator, removeAllSpy, addUriSpy, setUriSpy, switchSpy, playSpy } =
      makeCoordinator();
    installDevice({ Uuid: "RINCON_AAA", Coordinator: coordinator });

    const favorite = {
      uri: "x-sonos-http:track.mp3",
      upnpClass: "object.item.audioItem.musicTrack",
      title: "A Track",
      metadata: "DIDL_TRACK",
    };

    const result = await service.playFavorite("RINCON_AAA", favorite);

    expect(result).toBe(true);
    expect(removeAllSpy).toHaveBeenCalledTimes(1);
    expect(addUriSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        EnqueuedURI: favorite.uri,
        EnqueuedURIMetaData: "DIDL_TRACK",
      }),
    );
    expect(switchSpy).toHaveBeenCalledTimes(1);
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(setUriSpy).not.toHaveBeenCalled();
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

  it("getFavorites browses FV:2 and parses res + resMD, filtering unplayable entries", async () => {
    const esc = (s: string) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    const innerDidl =
      '<DIDL-Lite xmlns="x"><item id="c" parentID="c" restricted="true">' +
      "<dc:title>My Playlist</dc:title>" +
      "<upnp:class>object.container.playlistContainer</upnp:class>" +
      '<desc id="cdudn" nameSpace="ns">SA_RINCON_TOKEN</desc>' +
      "</item></DIDL-Lite>";

    const didl =
      '<DIDL-Lite xmlns="x">' +
      '<item id="FV:2/10" parentID="FV:2" restricted="false">' +
      "<dc:title>My Playlist</dc:title>" +
      '<res protocolInfo="x-rincon-cpcontainer:*:*:*">' +
      "x-rincon-cpcontainer:1234?sid=9&amp;sn=2</res>" +
      "<upnp:albumArtURI>http://art/p.jpg</upnp:albumArtURI>" +
      `<r:resMD>${esc(innerDidl)}</r:resMD>` +
      "</item>" +
      '<item id="FV:2/11" parentID="FV:2" restricted="false">' +
      "<dc:title>Radio Tile</dc:title>" +
      '<res protocolInfo="x"></res>' +
      "</item>" +
      "</DIDL-Lite>";

    const responseData =
      "<s:Envelope><s:Body><u:BrowseResponse>" +
      `<Result>${esc(didl)}</Result>` +
      "<NumberReturned>2</NumberReturned><TotalMatches>2</TotalMatches><UpdateID>1</UpdateID>" +
      "</u:BrowseResponse></s:Body></s:Envelope>";

    axiosPostSpy.mockResolvedValue({ data: responseData });
    installDevice({ Uuid: "RINCON_AAA", Host: "192.168.1.10" });

    const result = await service.getFavorites("RINCON_AAA");

    expect(result).toEqual([
      {
        uri: "x-rincon-cpcontainer:1234?sid=9&sn=2",
        upnpClass: "object.container.playlistContainer",
        title: "My Playlist",
        albumArtUrl: "http://art/p.jpg",
        metadata: esc(innerDidl),
      },
    ]);

    const [url] = axiosPostSpy.mock.calls[0];
    expect(url).toContain("192.168.1.10");
    expect(url).toContain("/MediaServer/ContentDirectory/Control");
  });

  it("playStream wraps the url in x-rincon-mp3radio with empty metadata then plays", async () => {
    const { coordinator, setUriSpy, playSpy, removeAllSpy, addUriSpy } =
      makeCoordinator();
    installDevice({ Uuid: "RINCON_AAA", Coordinator: coordinator });

    const result = await service.playStream(
      "RINCON_AAA",
      "https://stream.example/aac",
    );

    expect(result).toBe(true);
    expect(setUriSpy).toHaveBeenCalledWith({
      InstanceID: 0,
      CurrentURI: "x-rincon-mp3radio://https://stream.example/aac",
      CurrentURIMetaData: "",
    });
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(removeAllSpy).not.toHaveBeenCalled();
    expect(addUriSpy).not.toHaveBeenCalled();
  });

  it("playStream does not double-prefix an already-schemed url", async () => {
    const { coordinator, setUriSpy } = makeCoordinator();
    installDevice({ Uuid: "RINCON_AAA", Coordinator: coordinator });

    await service.playStream(
      "RINCON_AAA",
      "x-rincon-mp3radio://https://stream.example/aac",
    );

    expect(setUriSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        CurrentURI: "x-rincon-mp3radio://https://stream.example/aac",
      }),
    );
  });

  it("playStream returns false and logs when SetAVTransportURI throws", async () => {
    const { coordinator, setUriSpy, playSpy } = makeCoordinator();
    setUriSpy.mockRejectedValue(new Error("boom"));
    installDevice({ Uuid: "RINCON_AAA", Coordinator: coordinator });

    const result = await service.playStream("RINCON_AAA", "https://stream.example/aac");

    expect(result).toBe(false);
    expect(errorMock).toHaveBeenCalled();
    expect(playSpy).not.toHaveBeenCalled();
  });
});
