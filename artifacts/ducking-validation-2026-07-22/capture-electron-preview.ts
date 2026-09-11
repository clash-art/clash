import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const cdpPort = Number(process.argv[2] ?? 49371);
const outputDir = process.argv[3];
const durationMs = Number(process.argv[4] ?? 10000);
const fps = Number(process.argv[5] ?? 10);
const autoPlay = process.argv[6] === 'autoplay';

if (!outputDir) throw new Error('output directory is required');
await mkdir(outputDir, { recursive: true });

const targets = await fetch(`http://127.0.0.1:${cdpPort}/json`).then((response) => response.json());
const target = targets.find((candidate) => (
  candidate.type === 'page' && candidate.url.includes('/projects/')
));
if (!target?.webSocketDebuggerUrl) throw new Error('Electron project target was not found');

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let requestId = 0;

socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++requestId;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

await send('Page.enable');
await send('Runtime.enable');
if (autoPlay) {
  let timelineReady = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const readiness = await send('Runtime.evaluate', {
      expression: `!!document.querySelector('main[aria-label$="Timeline editor"]')`,
      returnByValue: true,
    });
    timelineReady = readiness.result.value === true;
    if (timelineReady) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!timelineReady) throw new Error('Timeline editor did not become ready');
  await send('Runtime.evaluate', {
    expression: `(() => {
      document.querySelector('[data-dnd-id="item-music-clip"]')?.click();
      return true;
    })()`,
    returnByValue: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const prepared = await send('Runtime.evaluate', {
    expression: `(() => {
      const meter = document.querySelector('button[aria-label="Audio level meter"]');
      if (meter?.getAttribute('aria-pressed') !== 'true') meter?.click();
      const playhead = document.querySelector('input[aria-label="Playhead"]');
      if (playhead) {
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setValue.call(playhead, '0');
        playhead.dispatchEvent(new Event('input', { bubbles: true }));
        playhead.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return JSON.stringify({
        timeline: !!document.querySelector('main[aria-label$="Timeline editor"]'),
        duckingInspector: !!document.querySelector('input[aria-label="Automatic audio ducking"]'),
        meter: meter?.getAttribute('aria-pressed'),
        playhead: playhead?.value,
      });
    })()`,
    returnByValue: true,
  });
  process.stdout.write(`prepared: ${prepared.result.value}\n`);
}
process.stdout.write('capture ready\n');

const frameIntervalMs = 1000 / fps;
const frameCount = Math.ceil(durationMs / frameIntervalMs);
const startedAt = performance.now();
for (let index = 0; index < frameCount; index += 1) {
  if (autoPlay && index === fps) {
    await send('Runtime.evaluate', {
      expression: `document.querySelector('button[aria-label="Play"]')?.click()`,
      returnByValue: true,
    });
  }
  if (autoPlay && [fps * 2, fps * 4, fps * 8].includes(index)) {
    const sample = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        playhead: document.querySelector('input[aria-label="Playhead"]')?.value,
        heading: document.querySelector('h1')?.innerText,
        audio: [...document.querySelectorAll('audio')].map((element) => ({
          volume: element.volume,
          currentTime: element.currentTime,
          paused: element.paused,
        })),
      })`,
      returnByValue: true,
    });
    process.stdout.write(`sample ${index}: ${sample.result.value}\n`);
  }
  const result = await send('Page.captureScreenshot', {
    format: 'jpeg',
    quality: 88,
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const fileName = `frame-${String(index).padStart(4, '0')}.jpg`;
  await writeFile(path.join(outputDir, fileName), Buffer.from(result.data, 'base64'));
  const nextFrameAt = startedAt + ((index + 1) * frameIntervalMs);
  const delayMs = Math.max(0, nextFrameAt - performance.now());
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

socket.close();
process.stdout.write(`captured ${frameCount} frames\n`);
