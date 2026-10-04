/** macOS arm64 update artifact names (preview and stable share the pattern). */

export function clashMacArm64ZipName(version: string): string {
  return `Clash-Desktop-${version}-macOS-arm64.zip`;
}

export function clashMacArm64ZipBlockmapName(version: string): string {
  return `${clashMacArm64ZipName(version)}.blockmap`;
}
