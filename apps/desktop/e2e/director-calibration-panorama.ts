import path from "node:path";
import { fileURLToPath } from "node:url";

const TWO_PI = Math.PI * 2;

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function distanceToMultiple(value, interval) {
  const remainder = Math.abs(value % interval);
  return Math.min(remainder, interval - remainder);
}

function smoothLine(distance, width) {
  if (distance >= width) return 0;
  const normalized = 1 - distance / width;
  return normalized * normalized * (3 - 2 * normalized);
}

function blend(base, accent, amount) {
  return base.map((channel, index) =>
    clampByte(channel + (accent[index] - channel) * amount),
  );
}

export function renderDirectorCalibrationPanorama({
  width = 2048,
  height = 1024,
  cameraPosition = [8, 6, 10],
} = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new TypeError("width and height must be positive integers");
  }
  if (width !== height * 2) {
    throw new RangeError("calibration panorama must use a 2:1 equirectangular aspect ratio");
  }

  const pixels = new Uint8ClampedArray(width * height * 4);
  const [cameraX, cameraY, cameraZ] = cameraPosition;

  for (let pixelY = 0; pixelY < height; pixelY += 1) {
    const v = 1 - (pixelY + 0.5) / height;
    const latitude = (v - 0.5) * Math.PI;
    const cosLatitude = Math.cos(latitude);
    const directionY = Math.sin(latitude);

    for (let pixelX = 0; pixelX < width; pixelX += 1) {
      const u = (pixelX + 0.5) / width;
      const longitude = (u - 0.5) * TWO_PI;
      const directionX = cosLatitude * Math.cos(longitude);
      const directionZ = cosLatitude * Math.sin(longitude);
      const index = (pixelY * width + pixelX) * 4;
      let color;

      if (directionY >= -0.000001) {
        const horizonProximity = Math.exp(-Math.abs(directionY) * 32);
        const zenith = Math.max(0, directionY);
        color = [
          6 + horizonProximity * 7 + zenith * 2,
          9 + horizonProximity * 12 + zenith * 2,
          15 + horizonProximity * 18 + zenith * 3,
        ];
      } else {
        const distance = -cameraY / directionY;
        const worldX = cameraX + directionX * distance;
        const worldZ = cameraZ + directionZ * distance;
        const fade = Math.max(0, Math.min(1, 1 - distance / 180));
        const floorBase = [
          8 + fade * 2,
          12 + fade * 3,
          20 + fade * 4,
        ];

        const projectedPixelWidth = Math.max(0.025, distance * (TWO_PI / width) * 0.7);
        const minorWidth = Math.min(0.18, projectedPixelWidth);
        const majorWidth = Math.min(0.28, projectedPixelWidth * 1.75);
        const minorDistance = Math.min(
          distanceToMultiple(worldX, 1),
          distanceToMultiple(worldZ, 1),
        );
        const majorDistance = Math.min(
          distanceToMultiple(worldX, 5),
          distanceToMultiple(worldZ, 5),
        );
        const minorStrength = smoothLine(minorDistance, minorWidth) * (0.55 + fade * 0.35);
        const majorStrength = smoothLine(majorDistance, majorWidth) * (0.75 + fade * 0.25);
        const xAxisStrength = smoothLine(Math.abs(worldZ), majorWidth * 0.8) * fade;
        const zAxisStrength = smoothLine(Math.abs(worldX), majorWidth * 0.8) * fade;

        color = blend(floorBase, [25, 91, 124], minorStrength);
        color = blend(color, [45, 154, 192], majorStrength);
        color = blend(color, [164, 58, 77], xAxisStrength);
        color = blend(color, [46, 167, 196], zAxisStrength);
      }

      pixels[index] = clampByte(color[0]);
      pixels[index + 1] = clampByte(color[1]);
      pixels[index + 2] = clampByte(color[2]);
      pixels[index + 3] = 255;
    }
  }

  return { width, height, pixels };
}

async function runCli() {
  const outputPath =
    process.argv[2] ??
    path.join(process.cwd(), ".tmp", "director-stage-calibration-grid-2048x1024.png");
  const width = Number.parseInt(process.env.CLASH_CALIBRATION_PANORAMA_WIDTH ?? "2048", 10);
  const height = width / 2;
  const rendered = renderDirectorCalibrationPanorama({ width, height });
  const { default: sharp } = await import("sharp");

  await sharp(Buffer.from(rendered.pixels), {
    raw: {
      width: rendered.width,
      height: rendered.height,
      channels: 4,
    },
  })
    .png()
    .toFile(outputPath);

  console.log(
    JSON.stringify({
      outputPath,
      width: rendered.width,
      height: rendered.height,
      cameraPosition: [8, 6, 10],
      minorGridMeters: 1,
      majorGridMeters: 5,
    }),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCli();
}
