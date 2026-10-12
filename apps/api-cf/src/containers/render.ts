import { serverLog } from "../logger";
import { Container } from "@cloudflare/containers";

export class RenderContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";

  override onStart() {
    console.log("[RenderContainer] Started");
  }

  override onStop() {
    console.log("[RenderContainer] Stopped");
  }

  override onError(error: unknown) {
    serverLog.child("render-container").error("render_container.error", { error });
  }
}
