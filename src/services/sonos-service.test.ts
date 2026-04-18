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

const managerState: {
  devices: unknown[];
  initSpy: (ip: string) => Promise<unknown>;
} = {
  devices: [],
  initSpy: async () => undefined,
};

vi.mock("@svrooij/sonos", () => {
  class MockSonosManager {
    public Devices: unknown[];
    public InitializeFromDevice = (ip: string) => managerState.initSpy(ip);
    constructor() {
      this.Devices = managerState.devices;
    }
  }
  return { SonosManager: MockSonosManager };
});

vi.mock("./discovery-service", () => ({
  discoverSonosDevices: vi.fn(),
}));

import streamDeck from "@elgato/streamdeck";
import { discoverSonosDevices } from "./discovery-service";
import { SonosService } from "./sonos-service";

describe("SonosService.getDeviceByUuid", () => {
  let service: SonosService;
  const discoverMock = discoverSonosDevices as unknown as ReturnType<typeof vi.fn>;
  const errorMock = streamDeck.logger.error as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    managerState.devices = [];
    managerState.initSpy = async () => undefined;
    discoverMock.mockReset();
    errorMock.mockReset();

    service = SonosService.getInstance();
    (service as unknown as { manager?: unknown }).manager = undefined;
    (service as unknown as { device?: unknown }).device = undefined;
    (service as unknown as { isInitialized: boolean }).isInitialized = false;
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
    (service as unknown as { manager: unknown }).manager = {
      Devices: [existing],
      InitializeFromDevice: initSpy,
    };
    discoverMock.mockResolvedValue([
      { uuid: "RINCON_BBB", ip: "192.168.1.20", name: "Living" },
    ]);

    const result = await service.getDeviceByUuid("RINCON_BBB");

    expect(result).toBe(target);
    expect(initSpy).toHaveBeenCalledWith("192.168.1.20");
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
});
