import { type SonosFavorite } from "./sonos-favorite";

export type SonosSettings = {
  deviceUuid?: string;
  deviceName?: string;
  ipAddress?: string;
};

export type SonosFavoriteSettings = SonosSettings & {
  favorite?: SonosFavorite;
};
