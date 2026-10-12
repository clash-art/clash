export interface DirectorRenderedFrame {
  timeSeconds: number;
  canvas: HTMLCanvasElement;
}

export interface DirectorWebGlRendererLike {
  render(scene: unknown, camera: unknown): void;
}

export function createDirectorFramePublicationGate(requiredStableFrames = 8): {
  tick(resourcesActive: boolean): boolean;
  /** True from publication until `reset()`. */
  published(): boolean;
  reset(): void;
} {
  if (!Number.isInteger(requiredStableFrames) || requiredStableFrames < 1) {
    throw new Error("Director frame publication requires a positive stable-frame count");
  }
  let stableFrames = 0;
  let published = false;
  return {
    tick(resourcesActive) {
      if (published) return false;
      if (resourcesActive) {
        stableFrames = 0;
        return false;
      }
      stableFrames += 1;
      if (stableFrames < requiredStableFrames) return false;
      published = true;
      return true;
    },
    published() {
      return published;
    },
    reset() {
      stableFrames = 0;
      published = false;
    },
  };
}

/**
 * Shared completion boundary for interactive and headless Director rendering.
 * A frame is publishable only after the same Three renderer used by the
 * DirectorViewport has drawn the evaluated scene into its product canvas.
 */
export function renderDirectorFrameNow(input: {
  renderer: DirectorWebGlRendererLike;
  scene: unknown;
  camera: unknown;
  timeSeconds: number;
  canvas: HTMLCanvasElement;
  publish: (frame: DirectorRenderedFrame) => void;
}): void {
  input.renderer.render(input.scene, input.camera);
  input.publish({ timeSeconds: input.timeSeconds, canvas: input.canvas });
}

/**
 * One tick of the headless render loop: draw until the frame is published, then stop.
 *
 * Drawing on after publication is not harmless. A software rasteriser needs seconds for one large
 * frame while the page can issue one every animation frame, so the GPU process falls behind; the
 * PNG readback then waits for every queued frame, and the backlog keeps the GPU process busy long
 * after the page is closed. The published frame stays in the canvas (`preserveDrawingBuffer`).
 */
export function renderDirectorPublicationFrame(input: {
  gate: ReturnType<typeof createDirectorFramePublicationGate>;
  resourcesActive: boolean;
  renderer: DirectorWebGlRendererLike;
  scene: unknown;
  camera: unknown;
  timeSeconds: number;
  canvas: HTMLCanvasElement;
  publish: (frame: DirectorRenderedFrame) => void;
}): void {
  if (input.gate.published()) return;
  input.renderer.render(input.scene, input.camera);
  if (!input.gate.tick(input.resourcesActive)) return;
  renderDirectorFrameNow(input);
}

const CAPTURE_TIMEOUT_MS = 60_000;
const CAPTURE_TIMEOUT_REFERENCE_PIXELS = 1920 * 1080;

/**
 * How long one headless capture may take before it is reported as timed out.
 *
 * Rasterising is linear in pixels, and without a GPU it is the whole cost: a capture draws the
 * frame about nine times (the settle frames plus the published one) on CPU threads. A fixed limit
 * that suits 1920x1080 is therefore too tight for the largest supported frame, which has 4.6
 * times the pixels, on a busy GPU-less host. The limit stays at one minute up to 1920x1080 and
 * grows in proportion beyond it.
 */
export function directorCaptureTimeoutMs(width: number, height: number): number {
  return Math.round(
    CAPTURE_TIMEOUT_MS *
      Math.max(1, (width * height) / CAPTURE_TIMEOUT_REFERENCE_PIXELS),
  );
}
