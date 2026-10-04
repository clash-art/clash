/**
 * Parse electron-updater differential download logs for stable-release e2e.
 * Matches electron-updater 6.8.x DifferentialDownloader plan lines.
 */

const DIFFERENTIAL_PLAN_RE =
  /Full:\s*.+?,\s*To download:\s*[^(\n]+\(\s*(\d+)\s*%\s*\)/is;

const DIFFERENTIAL_FAILURE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "Cannot download differentially", re: /Cannot download differentially/i },
  { label: "fallback to full download", re: /fallback to full download/i },
  { label: "falling back to full download", re: /falling back to full download/i },
  {
    label: "Unable to locate previous update.zip",
    re: /Unable to locate previous update\.zip/i,
  },
];

export function parseHumanDataSize(text: string): number | null {
  const match = /^([\d,]+(?:\.\d+)?)\s*(KB|MB|GB|B)?$/i.exec(text.trim());
  if (!match?.[1]) return null;
  const amount = Number(match[1].replaceAll(",", ""));
  if (!Number.isFinite(amount)) return null;
  const unit = (match[2] ?? "B").toUpperCase();
  if (unit === "GB") return Math.round(amount * 1024 ** 3);
  if (unit === "MB") return Math.round(amount * 1024 ** 2);
  if (unit === "KB") return Math.round(amount * 1024);
  return Math.round(amount);
}

/** Network bytes for a differential update (not assembled zip size). */
export function parseDifferentialDownloadBytes(
  logText: string,
  fullPackageBytes = 0,
): number | null {
  const text = logText ?? "";
  const plan = DIFFERENTIAL_PLAN_RE.exec(text);
  if (plan?.[1]) {
    const percent = Number(plan[1]);
    if (Number.isFinite(percent) && fullPackageBytes > 0) {
      return Math.round((fullPackageBytes * percent) / 100);
    }
  }
  const toDownload = /To download:\s*([\d,]+(?:\.\d+)?\s*(?:KB|MB|GB|B))/i.exec(
    text,
  );
  if (toDownload?.[1]) {
    const parsed = parseHumanDataSize(toDownload[1]);
    if (parsed != null) return parsed;
  }
  let fromProgress: number | null = null;
  for (const match of text.matchAll(/transferred[^0-9]*(\d+)[^0-9]+(\d+)/gi)) {
    const value = Number(match[1]);
    fromProgress = Math.max(fromProgress ?? 0, value);
  }
  return fromProgress;
}

export function analyzeUpdaterDownload(
  logText: string,
  fullPackageBytes = 0,
): { downloadedBytes: number | null } {
  return {
    downloadedBytes: parseDifferentialDownloadBytes(logText, fullPackageBytes),
  };
}

export function differentialFailureReasons(logText: string): string[] {
  const text = logText ?? "";
  return DIFFERENTIAL_FAILURE_PATTERNS.filter(({ re }) => re.test(text)).map(
    ({ label }) => label,
  );
}

export function assertDifferentialUpdate(
  logText: string,
  fullPackageBytes: number,
): { errors: string[]; analysis: { downloadedBytes: number | null } } {
  const analysis = analyzeUpdaterDownload(logText, fullPackageBytes);
  const errors: string[] = [];
  for (const reason of differentialFailureReasons(logText)) {
    errors.push(`updater log indicates failed differential: ${reason}`);
  }
  const downloadedBytes = analysis.downloadedBytes;
  if (downloadedBytes == null) {
    errors.push(
      "could not determine differential download bytes from updater log",
    );
  } else if (fullPackageBytes > 0 && downloadedBytes >= fullPackageBytes * 0.9) {
    errors.push(
      `downloaded bytes ${downloadedBytes} are not smaller than 90% of full zip ${fullPackageBytes}`,
    );
  }
  return { errors, analysis: { downloadedBytes } };
}
