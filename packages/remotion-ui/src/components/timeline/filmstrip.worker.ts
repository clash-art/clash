/// <reference lib="webworker" />
// Decodes timeline filmstrip frames with WebCodecs (via mediabunny's demuxer
// and CanvasSink) and composes the strip on an OffscreenCanvas, off the main
// thread.
import { ALL_FORMATS, CanvasSink, Input, UrlSource } from 'mediabunny';
import {
  filmstripSampleTimes,
  type FilmstripWorkerRequest,
  type FilmstripWorkerResponse,
} from './filmstripWorkerProtocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: FilmstripWorkerResponse, transfer: Transferable[] = []) =>
  scope.postMessage(message, transfer);

async function build(request: FilmstripWorkerRequest): Promise<void> {
  const { id } = request;
  const input = new Input({ source: new UrlSource(request.src), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return post({ id, type: 'unsupported', reason: 'no video track' });
    if (!(await track.canDecode())) return post({ id, type: 'unsupported', reason: 'codec not decodable' });

    const displayWidth = await track.getDisplayWidth();
    const displayHeight = await track.getDisplayHeight();
    const frameHeight = request.frameHeight;
    const frameWidth = Math.max(1, Math.floor((displayWidth / displayHeight) * frameHeight));
    const sampleCount = Math.max(1, request.sampleCount);
    post({ id, type: 'meta', frameWidth, frameHeight, sampleCount });

    const strip = new OffscreenCanvas(frameWidth * sampleCount, frameHeight);
    const context = strip.getContext('2d');
    if (!context) return post({ id, type: 'unsupported', reason: 'no 2d context' });

    const firstTimestamp = await track.getFirstTimestamp();
    const sink = new CanvasSink(track, { width: frameWidth, height: frameHeight, fit: 'fill', poolSize: 2 });
    const times = filmstripSampleTimes(request.duration, sampleCount).map((time) => firstTimestamp + time);
    let index = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(times)) {
      if (wrapped) {
        context.drawImage(wrapped.canvas, index * frameWidth, 0, frameWidth, frameHeight);
        const bitmap = await createImageBitmap(wrapped.canvas);
        post({ id, type: 'sample', index, bitmap }, [bitmap]);
      }
      index += 1;
    }
    const blob = await strip.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
    post({ id, type: 'done', blob });
  } catch (error) {
    post({ id, type: 'unsupported', reason: error instanceof Error ? error.message : String(error) });
  } finally {
    input.dispose();
  }
}

scope.onmessage = (event: MessageEvent<FilmstripWorkerRequest>) => {
  void build(event.data);
};
