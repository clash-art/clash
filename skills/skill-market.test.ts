import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { sourceContains, sourceMatches } from "../packages/web-ui/src/test-support/source-match";

const repoRoot = path.resolve(import.meta.dirname, "..");
const registryPath = path.join(repoRoot, "skills", "registry.json");
const evalsPath = path.join(repoRoot, "skills", "video-production", "evals", "evals.json");
const clashCommandsReferencePath = path.join(repoRoot, "skills", "clash", "references", "commands.md");
const agenticVideoCreatorSkillPath = path.join(
  repoRoot,
  "skills",
  "video-production",
  "agentic-video-creator",
  "SKILL.md",
);
const agenticVideoCreatorLoopPath = path.join(
  repoRoot,
  "skills",
  "video-production",
  "agentic-video-creator",
  "references",
  "production-loop.md",
);
const agenticVideoCreatorExecutionPath = path.join(
  repoRoot,
  "skills",
  "video-production",
  "agentic-video-creator",
  "references",
  "clash-execution.md",
);
const clashCanvasReferencePath = path.join(repoRoot, "skills", "clash", "references", "canvas.md");
const forbiddenInternalSurfacePattern =
  /\b(snapshot\.bin|local\.sqlite|sqlite|loro|room|variables|runtime\/|\.clash\/db)\b/i;

function parseFrontmatter(markdown: string) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, "SKILL.md must start with YAML frontmatter");
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) continue;
    fields[pair[1]] = pair[2].replace(/^["']|["']$/g, "");
  }
  return fields;
}

test("first-party skill marketplace registry is self-contained and installable", async () => {
  assert.ok(existsSync(registryPath), "skills/registry.json should exist");
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const registrySchema = JSON.parse(await readFile(path.join(repoRoot, "skills", "registry.schema.json"), "utf8"));
  // Workflow evals retired with the production command family.
  const evalSkillIds = new Set();

  assert.equal(registry.version, 1);
  assert.equal(
    registry.marketplaceSemantics?.skillBoundary,
    "portable-artifact-contract",
    "skills should be portable workflow/artifact contracts, not Clash runtime plugins",
  );
  assert.match(
    registry.marketplaceSemantics?.executionModel?.portableSkillExecution ?? "",
    /agent.*cwd/i,
    "portable skill execution should be owned by an agent working in its cwd",
  );
  assert.match(
    registry.marketplaceSemantics?.executionModel?.clashManagedExecution ?? "",
    /register assets.*metadata.*provenance.*review.*CAS/i,
    "Clash-managed execution should be collaboration and project-state management",
  );
  assert.match(
    registry.marketplaceSemantics?.executionModel?.hardBoundary ?? "",
    /missing Clash system capability.*not prevent portable skill execution/i,
    "missing Clash-native capability should not block portable skill workflows",
  );
  assert.match(
    registry.marketplaceSemantics?.hostCapabilityContract ?? "",
    /host capability contracts.*not Clash private storage or UI internals/i,
    "skills should depend on host capability contracts instead of Clash internals",
  );
  assert.match(
    registry.marketplaceSemantics?.hostCapabilityContract ?? "",
    /Clash is one host implementation.*collaboration/i,
    "Clash should be positioned as the collaboration and management host",
  );
  assert.deepEqual(
    registry.marketplaceSemantics?.artifactContract?.publicInterfaces,
    [
      "action",
      "metadata-fill",
      "asset",
      "analysis-metadata",
      "view-projection",
      "timeline-cas-apply",
      "schema",
    ],
    "portable skills should expose only stable public production interfaces",
  );
  assert.match(
    registry.marketplaceSemantics?.artifactContract?.skillOwnedWorkspace ?? "",
    /agent.*cwd.*draft/i,
    "skill-owned workspace should be the agent cwd draft area",
  );
  assert.deepEqual(
    registry.marketplaceSemantics?.artifactContract?.hostOwnedInternals,
    [
      "snapshot.bin",
      "project.sqlite",
      "loro-crdt-doc",
      "canvas-private-node-state",
      "runtime-secrets",
    ],
    "host-owned internals must be explicitly out of the portable skill contract",
  );
  assert.match(
    registry.marketplaceSemantics?.artifactContract?.forbiddenDependencyPolicy ?? "",
    /must not depend on.*snapshot\.bin.*SQLite.*Loro.*runtime secret/i,
    "skill contracts should forbid dependency on Clash internals",
  );
  assert.match(
    registry.marketplaceSemantics?.systemCapabilityMeaning ?? "",
    /Clash-native automation bindings/i,
    "system capabilities should describe Clash-native automation coverage",
  );
  assert.match(
    registry.marketplaceSemantics?.systemCapabilityMeaning ?? "",
    /not.*required.*run/i,
    "system capabilities must not be treated as a gate for portable skill execution",
  );
  assert.match(
    registry.marketplaceSemantics?.statusPolicy?.ready ?? "",
    /runnable.*local.*action|local.*CLI.*contract.*test/i,
    "ready status must mean a runnable capability with local CLI/action contract coverage",
  );
  assert.doesNotMatch(
    registry.marketplaceSemantics?.statusPolicy?.ready ?? "",
    /architecture|planning contract/i,
    "ready status must not be used for architecture or planning-only contracts",
  );
  assert.match(
    registry.marketplaceSemantics?.statusPolicy?.blockedBySystemGap ?? "",
    /systemGaps.*capability.*unblockSignal/i,
    "blocked-by-system-gap status should require explicit capability gaps and unblock signals",
  );
  assert.ok(
    registry.marketplaceSemantics?.clashRole?.includes("collaboration-management"),
    "registry should state that Clash owns collaboration and management",
  );
  const skillSchema = registrySchema.properties?.skills?.items;
  assert.ok(
    Array.isArray(skillSchema?.allOf),
    "registry schema should encode status-dependent skill gap rules",
  );
  assert.ok(
    JSON.stringify(skillSchema.allOf).includes('"blocked-by-system-gap"') &&
      JSON.stringify(skillSchema.allOf).includes('"systemGaps"'),
    "registry schema should require systemGaps for blocked-by-system-gap skills",
  );
  assert.ok(
    JSON.stringify(skillSchema.allOf).includes('"ready"') &&
      JSON.stringify(skillSchema.allOf).includes('"maxItems":0'),
    "registry schema should forbid unresolved systemGaps on ready skills",
  );
  assert.ok(Array.isArray(registry.skills));
  assert.ok(registry.skills.length >= 6, "expected the surviving architecture and authoring skills");
  assert.equal(registry.actions, undefined, "the marketplace no longer publishes action contracts");
  assert.ok(Array.isArray(registry.thirdPartyReferences), "third-party reference license ledger is required");

  const ids = new Set();
  const kinds = new Set();
  const capabilityIds = new Set(registry.systemCapabilities?.map((capability) => capability.id) ?? []);
  const referenceByName = new Map(registry.thirdPartyReferences.map((reference) => [reference.name, reference]));
  assert.ok(capabilityIds.has("media.asset-registry"), "media skills need an asset registry capability");
  assert.ok(capabilityIds.has("legal.oss-license-ledger"), "skill marketplace needs OSS license tracking");
  const capabilityById = new Map(registry.systemCapabilities.map((capability) => [capability.id, capability]));
  assert.equal(capabilityById.has("render.html-composition"), false);
  assert.equal(capabilityById.has("render.composition-router"), false);
  assert.equal(capabilityById.get("render.remotion-composition")?.status, "available");
  assert.match(
    capabilityById.get("render.remotion-composition")?.description ?? "",
    /remotion-component.*sourceNodeId.*latest TSX.*Timeline render/i,
  );
  assert.equal(capabilityById.get("render.export-validation")?.status, "partial");
  assert.match(
    capabilityById.get("render.export-validation")?.description ?? "",
    /Timeline render receipts.*playable-output evidence.*Loudness.*incomplete/i,
  );
  assert.equal(capabilityById.get("audio.word-timestamps")?.status, "partial");
  assert.match(
    capabilityById.get("audio.word-timestamps")?.description ?? "",
    /source path\/hash.*backend\/model|executing ASR backends.*missing/i,
  );



  const seedancePromptOptimizer = registry.skills.find((skill) => skill.id === "clash.video.sd25-pe");
  assert.equal(seedancePromptOptimizer?.name, "sd25-pe");
  assert.equal(seedancePromptOptimizer?.source, "provider-official");
  assert.equal(seedancePromptOptimizer?.sourceVersion, "0.1.1");
  assert.equal(seedancePromptOptimizer?.path, undefined);
  assert.deepEqual(seedancePromptOptimizer?.install, {
    kind: "npx-skills",
    source: "https://arkdocs.tos-cn-beijing.volces.com/skills/",
    skill: "sd25-pe",
    scope: "global",
  });
  assert.equal(seedancePromptOptimizer?.executionContract, "prompt-compiler");
  assert.deepEqual(seedancePromptOptimizer?.requiredSystemCapabilities, []);

  for (const skill of registry.skills) {
    assert.ok(
      skill.source === "first-party" || skill.source === "provider-official" || skill.source === "community",
      `${skill.id} should name a supported marketplace source`,
    );
    if (skill.source === "provider-official" || skill.source === "community") {
      assert.ok(skill.sourceVersion, `${skill.id} needs a pinned source version`);
      assert.ok(
        skill.install?.kind === "npx-skills" || skill.install?.kind === "bundled-skill",
        `${skill.id} needs a supported lazy installer`,
      );
      if (skill.install.kind === "npx-skills") {
        assert.ok(skill.install.source?.startsWith("https://"), `${skill.id} needs an upstream install source`);
      } else {
        assert.ok(existsSync(path.join(repoRoot, skill.path, "SKILL.md")), `${skill.id} needs its shipped skill`);
      }
      assert.equal(skill.install?.scope, "global", `${skill.id} should install independently of project cwd`);
    }
    // Eval prompts retired with the workflow family.
    void evalSkillIds;
    assert.ok(skill.id && !ids.has(skill.id), `duplicate skill id ${skill.id}`);
    ids.add(skill.id);
    kinds.add(skill.kind);
    assert.ok(Array.isArray(skill.requiredSystemCapabilities), `${skill.id} must declare system gaps`);
    assert.ok(!skill.researchSources?.includes("subagent-research"), `${skill.id} should name concrete research sources`);
    for (const source of skill.researchSources ?? []) {
      assert.ok(referenceByName.has(source), `${skill.id} references ${source} without a license ledger entry`);
    }
    for (const capability of skill.requiredSystemCapabilities) {
      assert.ok(capabilityIds.has(capability), `${skill.id} references unknown capability ${capability}`);
    }
    if (skill.status === "ready") {
      const hasNativePeerContract = skill.executionContract === "native-cli-mcp";
      const isPromptCompiler = skill.executionContract === "prompt-compiler";
      assert.ok(
        hasNativePeerContract || isPromptCompiler,
        `${skill.id} cannot be ready without an executable or prompt-compiler contract`,
      );
      if (skill.kind === "architecture") {
        assert.equal(
          hasNativePeerContract,
          true,
          `${skill.id} can be ready as architecture only when it names a native executable contract`,
        );
      }
      assert.ok(
        !Array.isArray(skill.systemGaps) || skill.systemGaps.length === 0,
        `${skill.id} is ready and must not carry unresolved system gaps`,
      );
    }
    if (skill.status === "blocked-by-system-gap") {
      assert.ok(Array.isArray(skill.systemGaps), `${skill.id} must list explicit system gaps`);
      assert.ok(skill.systemGaps.length > 0, `${skill.id} must list at least one blocking system gap`);
      for (const gap of skill.systemGaps) {
        assert.ok(
          skill.requiredSystemCapabilities.includes(gap.capability),
          `${skill.id} gap ${gap.capability} must be one of its required capabilities`,
        );
        assert.ok(capabilityIds.has(gap.capability), `${skill.id} gap ${gap.capability} must be a known capability`);
        assert.ok(gap.gap?.length > 24, `${skill.id} gap ${gap.capability} needs a concrete missing behavior`);
        assert.ok(gap.unblockSignal?.length > 24, `${skill.id} gap ${gap.capability} needs an unblock signal`);
      }
    }
    for (const publicArtifact of [...(skill.inputs ?? []), ...(skill.outputs ?? [])]) {
      assert.doesNotMatch(
        publicArtifact,
        forbiddenInternalSurfacePattern,
        `${skill.id} public artifact ${publicArtifact} must not point at Clash internals`,
      );
    }

    if (skill.source === "first-party" || skill.install?.kind === "bundled-skill") {
      const skillPath = path.join(repoRoot, skill.path, "SKILL.md");
      assert.ok(existsSync(skillPath), `${skill.id} SKILL.md missing at ${skill.path}`);
      const skillMarkdown = await readFile(skillPath, "utf8");
      const frontmatter = parseFrontmatter(skillMarkdown);
      assert.equal(frontmatter.name, skill.name, `${skill.id} frontmatter name should match registry`);
      assert.ok(frontmatter.description?.length > 60, `${skill.id} needs a trigger-rich description`);
      assert.doesNotMatch(
        skillMarkdown,
        /projections\/timelines\/[^\s"`]*\.lock\.json/,
        `${skill.id} docs must not tell agents to use projection-sidecar locks for timeline apply`,
      );
    }
  }

  assert.ok(
    JSON.stringify(skillSchema?.properties?.source).includes("provider-official"),
    "the registry schema should admit provider-official skills",
  );
  assert.ok(
    JSON.stringify(skillSchema?.properties?.executionContract).includes("prompt-compiler"),
    "the registry schema should admit prompt-only compiler skills",
  );
  assert.ok(
    JSON.stringify(skillSchema?.properties?.install).includes("npx-skills"),
    "the registry schema should admit declarative npx skills installers",
  );

  for (const reference of registry.thirdPartyReferences) {
    assert.ok(reference.url?.startsWith("https://"), `${reference.name} needs a source URL`);
    assert.ok(reference.license, `${reference.name} needs a license value`);
    assert.ok(reference.licenseSource?.startsWith("https://"), `${reference.name} needs a license source URL`);
    assert.ok(reference.integrationPolicy?.length > 40, `${reference.name} needs an integration policy`);
    if (/AGPL|Noncommercial|NOASSERTION|custom/i.test(reference.license)) {
      assert.notEqual(
        reference.usage,
        "reference-or-integration-with-notice",
        `${reference.name} has restrictive or unverified licensing and cannot be marked as directly integratable`,
      );
    }
  }

  assert.ok(kinds.has("architecture"), "registry should include architecture skills");
  // The concrete workflow-manual skills are retired with the command family.
  for (const retired of [
    "clash.video.talking-head-text-cut",
    "clash.video.music-video-beat-editing",
    "clash.video.tvc-reference-remix",
    "clash.audio.beat-analysis",
    "clash.audio.transcript-cut-planning",
    "clash.video.reference-ingest-analysis",
    "clash.image.character-reference-sheets",
  ]) {
    assert.equal(ids.has(retired), false, `${retired} must stay retired`);
  }

  const motionGraphics = registry.skills.find((skill) => skill.id === "clash.video.motion-graphics-overlays");
  assert.equal(motionGraphics?.status, "ready");
  assert.deepEqual(motionGraphics?.requiredSystemCapabilities, [
    "render.remotion-composition",
    "media.asset-registry",
    "timeline.cas-projection",
  ]);
  assert.deepEqual(motionGraphics?.systemGaps ?? [], []);

  const registryText = JSON.stringify(registry);
  assert.doesNotMatch(
    registryText,
    /render-mg|verify-mg-preview|export-mg|mg-overlay-manifest|mg-preview-verification|mg-video-export|render\.html-composition|first-party-rgba-rasterizer/i,
  );
});

test("discoverable MG guidance uses only live Remotion Canvas source and Timeline render", async () => {
  const [motionGraphics, runtimeGuidance, capabilities] = await Promise.all([
    readFile(path.join(repoRoot, "skills", "video-production", "motion-graphics-overlays", "SKILL.md"), "utf8"),
    readFile(path.join(repoRoot, "skills", "video-production", "composition-runtime-router", "SKILL.md"), "utf8").catch(() => ""),
    readFile(path.join(repoRoot, "skills", "video-production", "SYSTEM_CAPABILITIES.md"), "utf8"),
  ]);
  const discoverable = [motionGraphics, runtimeGuidance, capabilities].join("\n");

  assert.match(motionGraphics, /Remotion TSX/i);
  assert.match(motionGraphics, /remotion-component/);
  assert.match(motionGraphics, /sourceNodeId/);
  assert.match(motionGraphics, /timeline render/i);
  assert.doesNotMatch(
    discoverable,
    /render-mg|verify-mg-preview|export-mg|MgCompositionSpec|runtime:\s*["']html|selectedRuntime["']?:\s*["']html|first-party-rgba-rasterizer|clash-mg-frame/i,
  );
});

test("clash command reference does not expose removed vars CLI syntax", async () => {
  const commands = await readFile(clashCommandsReferencePath, "utf8");

  assert.match(commands, /Remote worker action secrets are managed in hosted\/remote Settings/);
  assert.doesNotMatch(commands, /clash vars/);
});

test("agentic video creator uses Canvas and Group as draft paths before Timeline commitment", async () => {
  const [skill, loop, execution] = await Promise.all([
    readFile(agenticVideoCreatorSkillPath, "utf8"),
    readFile(agenticVideoCreatorLoopPath, "utf8"),
    readFile(agenticVideoCreatorExecutionPath, "utf8"),
  ]);

  assert.match(skill, /Canvas\s+= .*draft room/i);
  assert.match(skill, /Group\s+= one draft path/i);
  assert.match(skill, /Timeline\s+= accepted ordered editorial state/i);
  assert.match(skill, /only selected media enters the\s+Timeline/i);
  assert.match(skill, /Do not create\s+separate Canvases merely for storyboard, A-roll, or B-roll/i);
  assert.match(loop, /Flova-like draft path maps to Clash/i);
  assert.match(
    loop,
    /Group label \/ path intent[\s\S]*storyboard \/ keyframe[\s\S]*primary-action generation[\s\S]*coverage generation[\s\S]*select note/i,
  );
  assert.match(loop, /Storyboard, A-roll, and B-roll are not sibling storage domains/i);
  assert.match(execution, /clash canvases create --project <project-id>/);
  assert.match(execution, /--canvas <canvas-id>/);
  assert.match(execution, /--id sequence-01/);
  assert.doesNotMatch(execution, /--id (?:storyboard|a-roll|b-roll)\b/);
  assert.match(execution, /Group\s+is a draft container, not a Timeline sequence/i);
});

test("agent-facing project docs expose recoverable project delete and restore", async () => {
  const commands = await readFile(clashCommandsReferencePath, "utf8");

  for (const docs of [commands]) {
    assert.match(docs, /clash projects get --id <project-id> --json/);
    assert.match(docs, /clash projects create --name/);
    assert.match(docs, /clash projects delete --id <project-id> --yes/);
    assert.match(docs, /clash project get --id <project-id> --include-deleted --json/);
    assert.match(docs, /clash project restore <project-id> --json/);
    assert.match(docs, /soft-delete|recoverable|restore/i);
    assert.match(docs, /implicitly|automatically/i);
    assert.doesNotMatch(docs, /readToken|--if-match|--force/);
    assert.doesNotMatch(docs, /removes the canvas, asset references, and history/i);
    assert.doesNotMatch(docs, /clash projects get <project-id>/);
    assert.doesNotMatch(docs, /clash projects create "<name>"/);
    assert.doesNotMatch(docs, /clash projects delete <project-id>/);
  }
});

test("agent-facing canvas docs use current option-based CLI syntax", async () => {
  const canvasDocs = [
    await readFile(clashCanvasReferencePath, "utf8"),
    await readFile(clashCommandsReferencePath, "utf8"),
  ].join("\n");

  // Every canvas verb must be documented as option-based, entity-explicit CLI.
  for (const verb of ["get", "list", "search", "add", "update", "replace-asset", "delete"]) {
    assert.match(
      canvasDocs,
      new RegExp(`clash canvas ${verb}[^\\n]*--project `),
      `canvas ${verb} must be documented with an explicit --project option`,
    );
    // The retired positional form took the entity id as a bare argument.
    assert.doesNotMatch(
      canvasDocs,
      new RegExp(`clash canvas ${verb} (?!--)[<\\w]`),
      `canvas ${verb} must not regress to positional entity arguments`,
    );
  }

  assert.doesNotMatch(canvasDocs, /clash canvas (?:connect|disconnect)\b/, "connection lifecycle is no longer a public command");
  assert.match(canvasDocs, /observed node version|cwd observation|implicit/i);
  assert.doesNotMatch(canvasDocs, /readToken|--if-match|--force/);
});

test("clash command reference exposes implicit cwd-observation direct patch CAS", async () => {
  const commands = await readFile(clashCommandsReferencePath, "utf8");

  assert.match(commands, /clash canvas get --project <id> --node <node-id> --json/);
  assert.match(commands, /\.clash\/observed\.json/);
  assert.match(commands, /clash canvas update --project <id> --node <id>/);
  assert.match(commands, /clash canvas delete --project <id> --node <id> --yes --json/);
  assert.match(commands, /For agents,[\s\S]*direct patch writes/i);
  assert.doesNotMatch(commands, /readToken|--if-match|--force/);
});

test("clash command reference exposes media asset copy-on-write replacement", async () => {
  const commands = await readFile(clashCommandsReferencePath, "utf8");

  assert.match(commands, /clash canvas replace-asset --project <id> --node <media-node-id> --asset <asset-id> --json/);
  assert.match(commands, /copy-on-write media node/i);
  assert.match(commands, /does not mutate existing downstream references/i);
});

test("clash command reference exposes text copy-on-write replacement", async () => {
  const commands = await readFile(clashCommandsReferencePath, "utf8");

  assert.match(commands, /clash text pull --project <id> --node <text-node-id> --json/);
  assert.match(commands, /clash text apply --project <id> --node <text-node-id> --json/);
  assert.match(commands, /clash text replace --project <id> --node <text-node-id> --json/);
  assert.match(commands, /copy-on-write text\s+node/i);
  assert.match(commands, /copy-on-write text node/i);
  assert.doesNotMatch(commands, /--lock|readToken|--if-match/);
});

test("clash command reference exposes concrete Timeline ownership and copy semantics", async () => {
  const commands = await readFile(clashCommandsReferencePath, "utf8");

  assert.match(commands, /clash timeline create --project <id> --id <timeline-id> --name <name> --json/);
  assert.match(commands, /clash timeline pull --project <id> --timeline <timeline-id> --json/);
  assert.match(commands, /clash timeline apply --project <id> --timeline <timeline-id> --json/);
  assert.match(commands, /clash timeline attach --project <id> --timeline <timeline-id> --canvas <canvas-id> --json/);
  assert.match(commands, /clash timeline copy --project <id> --timeline <timeline-id> --canvas <canvas-id> --json/);
  assert.match(commands, /records the Timeline\s+observation|observation implicitly/i);
  assert.match(commands, /creates a new Timeline\s+and Action node/i);
  assert.match(commands, /leaving the source unchanged/i);
  assert.doesNotMatch(commands, /--lock|readToken|--if-match/);
});

test("clash command reference retires the production command family", async () => {
  const commands = await readFile(clashCommandsReferencePath, "utf8");

  assert.doesNotMatch(commands, /clash production /, "the retired command family must not be taught");
  for (const retired of ["storyboard-prompt-pack", "plan-review-gate", "approve-review-gate", "apply-metadata-projection"]) {
    assert.doesNotMatch(commands, new RegExp(retired), `${retired} must stay retired`);
  }
  assert.doesNotMatch(commands, /--lock|readToken|--if-match/);
});

test("clash command reference teaches native Document edits and keeps legacy metadata read-only", async () => {
  const commands = await readFile(clashCommandsReferencePath, "utf8");
  for (const operation of ["create --kind text.plain --file script.txt", "pull <document-id> --file draft.txt", "apply <document-id> --file draft.txt", "copy <document-id> --revision <revision-id>"]) {
    assert.ok(sourceContains(commands, `clash assets documents ${operation}`));
  }
  assert.ok(sourceContains(commands, "clash assets metadata get --asset <asset-id> --kind media.transcript --body --json"));
  assert.ok(!sourceMatches(commands, /clash assets metadata (set|apply)/));
  assert.ok(sourceContains(commands, "METADATA_WRITE_RETIRED"));
  assert.ok(sourceContains(commands, "READ_REQUIRED"));
  assert.ok(sourceMatches(commands, /rejected as stale/));
  assert.ok(!sourceMatches(commands, /--lock|readToken|--if-match|--expect-version/));
});


test("standalone Clash instructions match the bundled product skill", async () => {
  const [standalone, bundled] = await Promise.all([
    readFile(path.join(repoRoot, "skills/clash/SKILL.md"), "utf8"),
    readFile(path.join(repoRoot, "plugins/clash/skills/clash/SKILL.md"), "utf8"),
  ]);
  // Install metadata can differ; installed agent instructions must not fork.
  const body = (markdown: string) => {
    const start = markdown.indexOf("# Use Clash\n");
    assert.notEqual(start, -1, "missing product instructions");
    return markdown.slice(start).trim();
  };
  assert.equal(body(standalone), body(bundled));
});
