import streamDeck, {
  action,
  KeyDownEvent,
  SingletonAction,
  WillAppearEvent,
} from "@elgato/streamdeck";
import { SonosService } from "../services/sonos-service";
import { tryCatch } from "../utils/tryCatch";
import { type SonosSettings } from "../types/sonos-settings";

@action({ UUID: "com.pavel-karpovich.sonos.previous-track" })
export class SonosPreviousTrackAction extends SingletonAction<SonosSettings> {
  private sonosService = SonosService.getInstance();

  override async onWillAppear(
    ev: WillAppearEvent<SonosSettings>,
  ): Promise<void> {
    const { error } = await tryCatch(
      this.sonosService.initialize(ev.payload.settings.ipAddress),
    );
    if (error) {
      streamDeck.logger.error(`Error in onWillAppear: ${error}`);
    }
  }

  override async onKeyDown(ev: KeyDownEvent<SonosSettings>): Promise<void> {
    const { data: success, error } = await tryCatch(
      this.sonosService.previousTrack(),
    );
    if (error) {
      streamDeck.logger.error(`Error in onKeyDown: ${error}`);
      return await ev.action.showAlert();
    }

    return success ? await ev.action.showOk() : await ev.action.showAlert();
  }
}
