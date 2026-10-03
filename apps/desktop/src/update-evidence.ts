import { appendFileSync } from "node:fs";

import { updateEvidencePath } from "./app-update.js";

export function recordUpdateEvidence(
  event: string,
  fields: Record<string, string | number | boolean>,
): void {
  const path = updateEvidencePath(process.env);
  if (!path) return;
  const line = JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    pid: process.pid,
    ...fields,
  });
  appendFileSync(path, `${line}\n`);
}
