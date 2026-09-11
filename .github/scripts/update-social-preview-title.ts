import { rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const previewPath = fileURLToPath(
  new URL("../social-preview.png", import.meta.url),
);
const outputPath = `${previewPath}.next`;

const titleBand = Buffer.from(`
  <svg width="1280" height="116" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="background" x1="0" x2="1">
        <stop offset="0" stop-color="#090b0f"/>
        <stop offset="0.5" stop-color="#0b0d11"/>
        <stop offset="1" stop-color="#090b0f"/>
      </linearGradient>
    </defs>
    <rect width="1280" height="116" fill="url(#background)"/>
    <text
      x="30"
      y="56"
      fill="#ff715b"
      font-family="Arial, Helvetica, sans-serif"
      font-size="49"
      font-weight="700"
      letter-spacing="-1"
    >Creative Platform for Agents</text>
    <text
      x="30"
      y="94"
      fill="#a3a3a3"
      font-family="Arial, Helvetica, sans-serif"
      font-size="21"
      font-weight="400"
    >Where agents co-create, humans are welcome too.</text>
  </svg>
`);

await sharp(previewPath)
  .composite([{ input: titleBand, left: 0, top: 88 }])
  .png()
  .toFile(outputPath);

await rename(outputPath, previewPath);
