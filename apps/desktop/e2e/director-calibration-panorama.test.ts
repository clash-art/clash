import assert from "node:assert/strict";
import test from "node:test";
import { renderDirectorCalibrationPanorama } from "./director-calibration-panorama.ts";

function pixelAt(rendered, x, y) {
  const index = (y * rendered.width + x) * 4;
  return [...rendered.pixels.slice(index, index + 4)];
}

function worldDirectionPixel(width, height, camera, point) {
  const direction = [
    point[0] - camera[0],
    point[1] - camera[1],
    point[2] - camera[2],
  ];
  const length = Math.hypot(...direction);
  const [x, y, z] = direction.map((value) => value / length);
  const u = Math.atan2(z, x) / (Math.PI * 2) + 0.5;
  const v = Math.asin(y) / Math.PI + 0.5;
  return [
    Math.min(width - 1, Math.max(0, Math.floor(u * width))),
    Math.min(height - 1, Math.max(0, Math.floor((1 - v) * height))),
  ];
}

test("renders a metric 2:1 equirectangular calibration panorama", () => {
  const camera = [8, 6, 10];
  const rendered = renderDirectorCalibrationPanorama({
    width: 720,
    height: 360,
    cameraPosition: camera,
  });
  assert.equal(rendered.width / rendered.height, 2);
  assert.equal(rendered.pixels.length, 720 * 360 * 4);

  const linePixel = worldDirectionPixel(720, 360, camera, [8, 0, 9]);
  const cellPixel = worldDirectionPixel(720, 360, camera, [8.5, 0, 9.5]);
  const line = pixelAt(rendered, ...linePixel);
  const cell = pixelAt(rendered, ...cellPixel);
  assert.ok(line[2] > cell[2] + 35, `expected grid line ${line} to be brighter than cell ${cell}`);

  const sky = pixelAt(rendered, 360, 60);
  const floor = pixelAt(rendered, 390, 300);
  assert.ok(sky[2] < 40, `expected dark sky, received ${sky}`);
  assert.ok(floor[2] < 90, `expected dark floor, received ${floor}`);
});
