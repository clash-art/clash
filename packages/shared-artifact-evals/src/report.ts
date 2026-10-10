import { access, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { ArtifactEvidence, BenchmarkSuiteReport } from "./types";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function urlPath(value: string): string {
  return value
    .split(/[\\/]+/u)
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

async function existingRelativePath(
  runRoot: string,
  absolutePath: string,
): Promise<string | undefined> {
  try {
    await access(absolutePath);
    const local = relative(runRoot, absolutePath);
    if (local === ".." || local.startsWith(`..${sep}`)) return undefined;
    return urlPath(local);
  } catch {
    return undefined;
  }
}

/**
 * Usability diagnostics come off disk, so every field is read defensively: a
 * missing or malformed trajectory only costs the panel, never the report.
 */
async function readTrajectoryUsability(
  candidatePaths: Array<string | undefined>,
): Promise<Record<string, unknown> | undefined> {
  for (const path of candidatePaths) {
    if (!path) continue;
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      const trajectory = parsed as {
        usability?: unknown;
        summary?: unknown;
      } | null;
      const usability = trajectory?.usability;
      if (
        usability &&
        typeof usability === "object" &&
        !Array.isArray(usability)
      ) {
        const summary = trajectory?.summary;
        const invocationSummary =
          summary && typeof summary === "object" && !Array.isArray(summary)
            ? (summary as Record<string, unknown>)
            : undefined;
        return {
          ...(usability as Record<string, unknown>),
          ...(typeof invocationSummary?.invocationCount === "number"
            ? { invocationCount: invocationSummary.invocationCount }
            : {}),
          ...(typeof invocationSummary?.failedInvocationCount === "number"
            ? {
                failedInvocationCount: invocationSummary.failedInvocationCount,
              }
            : {}),
        };
      }
    } catch {
      // Fall through to the next candidate path.
    }
  }
  return undefined;
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

function renderUsability(
  usability: Record<string, unknown> | undefined,
): string {
  if (!usability) return "";
  const count = (key: string): number => {
    const value = usability[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const strings = (key: string): string[] => {
    const value = usability[key];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  };
  const mutationMs = usability.timeToFirstSuccessfulMutationMs;
  const transports = strings("transportsUsed").map((transport) =>
    transport.toUpperCase(),
  );
  const errorCodes = strings("errorCodes");
  const chips = [
    ...(typeof usability.invocationCount === "number"
      ? [
          countLabel(
            count("invocationCount"),
            "tool invocation",
            "tool invocations",
          ),
        ]
      : []),
    ...(typeof usability.failedInvocationCount === "number"
      ? [
          countLabel(
            count("failedInvocationCount"),
            "failed tool invocation",
            "failed tool invocations",
          ),
        ]
      : []),
    countLabel(
      count("successfulClashActionCount"),
      "successful Clash action",
      "successful Clash actions",
    ),
    countLabel(
      count("failedClashActionCount"),
      "failed Clash action",
      "failed Clash actions",
    ),
    countLabel(
      count("recoveryCount"),
      "recovery after failure",
      "recoveries after failure",
    ),
    countLabel(
      count("parameterErrorCount"),
      "parameter error",
      "parameter errors",
    ),
    countLabel(count("helpActionCount"), "help detour", "help detours"),
    countLabel(
      count("contractDiscoveryActionCount"),
      "contract discovery call",
      "contract discovery calls",
    ),
    `${megabytes(count("contractResponseBytes"))} contract responses (largest ${megabytes(count("largestContractResponseBytes"))})`,
    ...(typeof mutationMs === "number" && Number.isFinite(mutationMs)
      ? [`${mutationMs.toLocaleString()} ms to first successful mutation`]
      : []),
    ...(transports.length > 0 ? [transports.join(" + ")] : []),
    countLabel(
      count("transportSwitchCount"),
      "transport switch",
      "transport switches",
    ),
    ...(errorCodes.length > 0 ? [errorCodes.join(" · ")] : []),
  ];
  return `<details class="usability" open><summary>Tool usability diagnostics — Non-gating: how hard Clash was to drive, never part of the score</summary><ul>${chips
    .map((chip) => `<li>${escapeHtml(chip)}</li>`)
    .join("")}</ul></details>`;
}

function renderArtifact(
  workspacePath: string,
  artifact: ArtifactEvidence,
): string {
  const source = `${workspacePath}/${urlPath(artifact.path)}`;
  const title = escapeHtml(`${artifact.id} · ${artifact.kind}`);
  const metadata = `<figcaption><a href="${source}">${title}</a><small>${artifact.bytes.toLocaleString()} bytes · ${escapeHtml(artifact.sha256.slice(0, 12))}</small></figcaption>`;
  if (artifact.kind === "video") {
    return `<figure class="artifact video"><video controls preload="metadata" src="${source}"></video>${metadata}</figure>`;
  }
  if (artifact.kind === "audio") {
    return `<figure class="artifact audio"><audio controls preload="metadata" src="${source}"></audio>${metadata}</figure>`;
  }
  if (artifact.kind === "image") {
    return `<figure class="artifact image"><a href="${source}"><img loading="lazy" src="${source}" alt="${title}"></a>${metadata}</figure>`;
  }
  return `<figure class="artifact source"><div class="file-kind">${escapeHtml(artifact.kind)}</div>${metadata}</figure>`;
}

export async function writeSuiteGallery(input: {
  report: BenchmarkSuiteReport;
  runRoot: string;
}): Promise<string> {
  const caseSections: string[] = [];
  for (const benchmarkCase of input.report.cases) {
    const caseRoot = join(benchmarkCase.workspace, "..");
    const workspacePath = urlPath(
      relative(input.runRoot, benchmarkCase.workspace),
    );
    const traceCandidates = [
      ["Agent trace", benchmarkCase.agent.stdoutPath],
      ["Raw agent trace", join(caseRoot, "logs", "events.jsonl")],
      ["CLI trace", join(caseRoot, "logs", "clash-cli-events.jsonl")],
      ["Normalized trajectory", benchmarkCase.agent.trajectoryPath],
      ["Normalized trajectory", join(caseRoot, "logs", "trajectory.json")],
      ["Normalized trajectory", join(caseRoot, "trajectory.json")],
      ["Attempt JSON", join(caseRoot, "attempt.json")],
      ["Result Bundle", join(caseRoot, "result-bundle.json")],
      ["Evaluation JSON", join(caseRoot, "evaluation.json")],
      ["Execution JSON", join(caseRoot, "execution.json")],
    ] as const;
    const traceLinks: string[] = [];
    const seenTracePaths = new Set<string>();
    for (const [label, path] of traceCandidates) {
      if (!path) continue;
      const local = await existingRelativePath(input.runRoot, path);
      if (local && !seenTracePaths.has(local)) {
        seenTracePaths.add(local);
        traceLinks.push(`<a href="${local}">${escapeHtml(label)}</a>`);
      }
    }
    const identityViolations =
      benchmarkCase.execution.identityIntegrity?.violations ?? [];
    const identityEvidence =
      identityViolations.length > 0
        ? `<details class="identity-evidence" open><summary>Identity integrity evidence</summary><ul>${identityViolations
            .map(
              (violation) =>
                `<li><strong>${escapeHtml(violation.code)}</strong> · ${escapeHtml(violation.source)} line ${violation.sourceLine}<code>${escapeHtml(violation.command)}</code></li>`,
            )
            .join("")}</ul></details>`
        : "";
    const automatedChecks = `<details class="automated-checks" open><summary>Automated evidence score — not an aesthetic score</summary><ul>${benchmarkCase.evaluation.checks
      .map(
        (check) =>
          `<li class="${escapeHtml(check.status)}"><strong>${escapeHtml(check.status.toUpperCase())} · ${escapeHtml(check.id)}</strong><span>${check.awardedWeight}/${check.weight}</span><p>${escapeHtml(check.detail)}</p></li>`,
      )
      .join("")}</ul></details>`;
    const qualityReview = benchmarkCase.qualityReview
      ? `<details class="quality-review ${escapeHtml(benchmarkCase.qualityReview.status)}" open><summary>Content-effect quality review · ${escapeHtml(benchmarkCase.qualityReview.status.toUpperCase())}</summary><p>${escapeHtml(benchmarkCase.qualityReview.detail)}</p>${
          benchmarkCase.qualityReview.result
            ? `<p><strong>${benchmarkCase.qualityReview.result.aggregate.score}/${benchmarkCase.qualityReview.result.aggregate.threshold}</strong> · ${escapeHtml(benchmarkCase.qualityReview.result.reviewer.provider)} / ${escapeHtml(benchmarkCase.qualityReview.result.reviewer.model)}</p><ul>${benchmarkCase.qualityReview.result.criteria
                .map(
                  (criterion) =>
                    `<li><strong>${escapeHtml(criterion.id)} · ${criterion.score}/100</strong><p>${escapeHtml(criterion.rationale)}</p></li>`,
                )
                .join("")}</ul>`
            : ""
        }</details>`
      : "";
    const usability = renderUsability(
      await readTrajectoryUsability([
        benchmarkCase.agent.trajectoryPath,
        join(caseRoot, "logs", "trajectory.json"),
        join(caseRoot, "trajectory.json"),
      ]),
    );
    const attemptState = [
      benchmarkCase.trial !== undefined
        ? `Trial ${benchmarkCase.trial}`
        : undefined,
      benchmarkCase.attempt !== undefined
        ? `Attempt ${benchmarkCase.attempt}`
        : undefined,
      benchmarkCase.failure
        ? `${benchmarkCase.failure.classification} failure`
        : undefined,
      benchmarkCase.forcePending
        ? "force-pending · another explicit --force is required"
        : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
    caseSections.push(`
      <section class="case ${benchmarkCase.status}">
        <header>
          <div><span class="badge">${escapeHtml(benchmarkCase.status === "pending-review" ? "PENDING REVIEW" : benchmarkCase.status.toUpperCase())}</span><h2>${escapeHtml(benchmarkCase.id)}</h2></div>
          <strong>Current selected aggregate view · ${benchmarkCase.evaluation.score}/100</strong>
        </header>
        ${attemptState ? `<p class="case-state">${escapeHtml(attemptState)}</p>` : ""}
        <p>Attempt is immutable and score-free; the status and score below are a derived view over selected Evaluation records.</p>
        <p>${escapeHtml(benchmarkCase.execution.detail)}</p>
        ${automatedChecks}
        ${qualityReview}
        ${usability}
        ${identityEvidence}
        <nav>${traceLinks.join("")}</nav>
        <div class="artifacts">${benchmarkCase.evaluation.artifacts.map((artifact) => renderArtifact(workspacePath, artifact)).join("")}</div>
      </section>`);
  }

  const passed = input.report.cases.filter(
    (item) => item.status === "pass",
  ).length;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.report.suiteId)} · ${escapeHtml(input.report.runId)}</title>
<style>
:root{color-scheme:dark;background:#0b0d12;color:#f5f7fb;font:15px/1.5 ui-sans-serif,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;padding:32px;max-width:1600px;margin:auto}h1,h2,p{margin:.2em 0}h1{font-size:clamp(28px,5vw,56px)}.summary{color:#aeb8ca;margin:0 0 28px}.case{border:1px solid #273043;border-radius:18px;padding:20px;margin:18px 0;background:#121722}.case.pass{border-color:#275c49}.case.fail{border-color:#713a43}.case.blocked{border-color:#80652e}.case.pending-review{border-color:#41678a}.case header,.case header div{display:flex;align-items:center;gap:12px;justify-content:space-between}.case header div{justify-content:flex-start}.case-state{color:#f5c2ca;font-weight:700}.badge{font-size:11px;font-weight:800;letter-spacing:.08em;padding:4px 8px;border-radius:99px;background:#263044}.pass .badge{background:#164936}.fail .badge{background:#5d2530}.blocked .badge{background:#66501e}.pending-review .badge{background:#244968}.automated-checks,.identity-evidence,.usability,.quality-review{margin:12px 0;border:1px solid #344057;border-radius:10px;padding:10px 12px;background:#0d121c}.automated-checks summary,.identity-evidence summary,.usability summary,.quality-review summary{cursor:pointer;font-weight:700}.quality-review.pending{border-color:#41678a}.quality-review.fail{border-color:#713a43}.quality-review.pass{border-color:#275c49}.quality-review ul{margin:8px 0 0;padding-left:20px}.quality-review li{margin:8px 0}.quality-review li p{color:#aeb8ca}.usability summary{color:#8fa3c4;font-weight:600}.automated-checks ul,.identity-evidence ul,.usability ul{margin:8px 0 0;padding:0;list-style:none}.usability ul{display:flex;flex-wrap:wrap;gap:8px}.usability li{border:1px solid #2c3a55;border-radius:99px;padding:4px 10px;font-size:13px;color:#c6d4ea;background:#111a29}.automated-checks li{display:grid;grid-template-columns:1fr auto;gap:2px 12px;padding:8px 0;border-top:1px solid #20283a}.automated-checks li p{grid-column:1/-1;color:#aeb8ca}.automated-checks li.fail strong{color:#ffb4bf}.identity-evidence{border-color:#713a43;background:#2a151a}.identity-evidence ul{padding-left:22px;list-style:disc}.identity-evidence li{margin:8px 0}.identity-evidence code{display:block;margin-top:4px;overflow-wrap:anywhere;color:#ffd5dc}nav{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}nav a,.source a{color:#b8d6ff;text-decoration:none;border:1px solid #344057;border-radius:8px;padding:6px 9px}.artifacts{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}.artifact{margin:0;background:#090c11;border:1px solid #20283a;border-radius:12px;overflow:hidden;min-width:0}.artifact video,.artifact img{display:block;width:100%;max-height:520px;object-fit:contain;background:#050609}.artifact audio{width:calc(100% - 24px);margin:20px 12px}.artifact figcaption{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:10px 12px}.artifact figcaption a{color:#dce8ff;overflow-wrap:anywhere}.artifact small{color:#8290a8;white-space:nowrap}.file-kind{height:120px;display:grid;place-items:center;text-transform:uppercase;font-weight:800;color:#8092b3;background:linear-gradient(135deg,#111827,#1e293b)}@media(max-width:600px){body{padding:18px}.case{padding:14px}.artifact figcaption{display:block}.artifact small{display:block}}
</style></head><body>
<h1>${escapeHtml(input.report.suiteId)}</h1>
<p class="summary">Run ${escapeHtml(input.report.runId)} · ${passed}/${input.report.cases.length} passed · ${escapeHtml(input.report.startedAt)} → ${escapeHtml(input.report.finishedAt)}</p>
${caseSections.join("\n")}
</body></html>\n`;
  const outputPath = join(input.runRoot, "report.html");
  await writeFile(outputPath, html, "utf8");
  return outputPath;
}
