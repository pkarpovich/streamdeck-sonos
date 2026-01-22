import { Bonjour, type Service } from "bonjour-service";
import axios from "axios";
import streamDeck from "@elgato/streamdeck";
import { tryCatch } from "../utils/tryCatch";

export type DiscoveredDevice = {
  uuid: string;
  name: string;
  ip: string;
  model?: string;
};

const DISCOVERY_TIMEOUT_MS = 5000;
const DEVICE_INFO_TIMEOUT_MS = 3000;

export async function discoverSonosDevices(): Promise<DiscoveredDevice[]> {
  const rawDevices = await discoverViaMdns();
  return Promise.all(rawDevices.map(enrichDeviceWithModel));
}

function discoverViaMdns(): Promise<DiscoveredDevice[]> {
  return new Promise((resolve) => {
    const bonjour = new Bonjour();
    const devices: DiscoveredDevice[] = [];
    const seenUuids = new Set<string>();

    const browser = bonjour.find({ type: "sonos" }, (service: Service) => {
      const uuid = extractUuidFromService(service);
      if (!uuid || seenUuids.has(uuid)) return;

      seenUuids.add(uuid);
      const ip = service.addresses?.find((addr) => addr.includes("."));
      if (!ip) return;

      devices.push({
        uuid,
        name: service.txt?.roomname || service.name.split("@")[1] || "Unknown",
        ip,
      });

      streamDeck.logger.info(`Discovered Sonos: ${devices[devices.length - 1].name} at ${ip}`);
    });

    setTimeout(() => {
      browser.stop();
      bonjour.destroy();
      streamDeck.logger.info(`mDNS discovery complete: found ${devices.length} device(s)`);
      resolve(devices);
    }, DISCOVERY_TIMEOUT_MS);
  });
}

async function enrichDeviceWithModel(device: DiscoveredDevice): Promise<DiscoveredDevice> {
  const { data, error } = await tryCatch(
    axios.get(`http://${device.ip}:1400/xml/device_description.xml`, { timeout: DEVICE_INFO_TIMEOUT_MS }),
  );

  if (error || !data?.data) return device;

  const xml = data.data as string;
  const modelMatch = xml.match(/<modelName>([^<]+)<\/modelName>/);
  const model = modelMatch?.[1];

  return {
    ...device,
    model,
    name: model ? `${device.name} (${model})` : device.name,
  };
}

function extractUuidFromService(service: Service): string | null {
  if (service.txt?.uuid) return service.txt.uuid;
  const match = service.name.match(/RINCON_[A-F0-9]+/);
  return match ? match[0] : null;
}
