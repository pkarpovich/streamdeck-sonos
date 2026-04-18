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

    service = SonosService.getInstance();
    (
      service as unknown as {
        manager?: unknown;
        managerPromise?: unknown;
        reinitInFlight?: unknown;
      }
    ).manager = undefined;
    (
      service as unknown as {
        manager?: unknown;
        managerPromise?: unknown;
        reinitInFlight?: unknown;
      }
    ).managerPromise = undefined;
    (
      service as unknown as {
        manager?: unknown;
        managerPromise?: unknown;
        reinitInFlight?: unknown;
      }
    ).reinitInFlight = undefined;
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
