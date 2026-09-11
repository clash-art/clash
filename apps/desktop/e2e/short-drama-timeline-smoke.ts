import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopDir, "..", "..");
const runId = process.env.CLASH_SHORT_DRAMA_TIMELINE_RUN_ID || new Date().toISOString().replace(/[:.]/g, "-");
const artifactRoot = path.resolve(
  process.env.CLASH_SHORT_DRAMA_TIMELINE_ARTIFACT_ROOT ||
    path.join(repoRoot, ".tmp", "short-drama-timeline", runId),
);
const defaultScenarioPath = path.join(repoRoot, ".tmp", "qa-scenarios", "short-drama-timeline-scenario.json");
const scenarioPath = path.resolve(process.env.CLASH_SHORT_DRAMA_SCENARIO_PATH || defaultScenarioPath);
const createdTimelinePath = path.join(artifactRoot, "timeline", "created", "short-drama-timeline.json");
const restoredTimelinePath = path.join(artifactRoot, "timeline", "restored", "short-drama-timeline.json");
const reportPath = path.join(artifactRoot, "short-drama-timeline-report.json");
const fps = 30;

const fallbackScenario = {
  schemaVersion: 1,
  title: "雨夜便利店打脸局",
  logline: "被羞辱的夜班店员用隐藏身份反转订单危机。",
  episodes: [
    {
      id: "ep-01",
      durationSeconds: 45,
      emotionMode: "press",
      hook: "雨夜，前任带着新欢进店羞辱她。",
      beats: [
        { atSeconds: 0, visual: "雨夜便利店外景", dialogue: "今晚别再出错。", assetKind: "video" },
        { atSeconds: 6, visual: "收银台特写", dialogue: "你还在这里打工？", assetKind: "text" },
        { atSeconds: 18, visual: "手机订单报警", dialogue: "这单丢了，你赔得起吗？", assetKind: "audio" },
        { atSeconds: 32, visual: "女主低头按下语音", dialogue: "把区域经理叫来。", assetKind: "image" },
      ],
      timelineExpectation: {
        tracks: [
          {
            id: "main-video",
            kind: "video",
            items: [
              { id: "ep1-rain-store", assetKind: "video", startSeconds: 0, durationSeconds: 45, label: "雨夜便利店外景" },
              { id: "ep1-phone-alert", assetKind: "image", startSeconds: 18, durationSeconds: 12, label: "手机订单报警" },
            ],
          },
          {
            id: "subtitles",
            kind: "text",
            items: [
              { id: "ep1-sub-insult", assetKind: "text", startSeconds: 6, durationSeconds: 8, label: "你还在这里打工？" },
              { id: "ep1-sub-manager", assetKind: "text", startSeconds: 32, durationSeconds: 8, label: "把区域经理叫来。" },
            ],
          },
          {
            id: "narration",
            kind: "audio",
            items: [
              { id: "ep1-audio-alert", assetKind: "audio", startSeconds: 18, durationSeconds: 18, label: "订单报警和压迫音效" },
            ],
          },
        ],
      },
    },
    {
      id: "ep-02",
      durationSeconds: 45,
      emotionMode: "release",
      hook: "经理冲进门，却先向店员鞠躬。",
      beats: [
        { atSeconds: 0, visual: "经理推门进店", dialogue: "顾总，您怎么亲自值班？", assetKind: "video" },
        { atSeconds: 10, visual: "前任表情崩塌", dialogue: "她是顾总？", assetKind: "text" },
        { atSeconds: 24, visual: "门店大屏切换任命公告", dialogue: "从今天起，这片区归她管。", assetKind: "image" },
        { atSeconds: 36, visual: "雨声停下", dialogue: "把他们列入黑名单。", assetKind: "audio" },
      ],
      timelineExpectation: {
        tracks: [
          {
            id: "main-video",
            kind: "video",
            items: [
              { id: "ep2-manager-enter", assetKind: "video", startSeconds: 45, durationSeconds: 45, label: "经理推门进店" },
              { id: "ep2-announcement", assetKind: "image", startSeconds: 69, durationSeconds: 12, label: "任命公告大屏" },
            ],
          },
          {
            id: "subtitles",
            kind: "text",
            items: [
              { id: "ep2-sub-boss", assetKind: "text", startSeconds: 45, durationSeconds: 10, label: "顾总，您怎么亲自值班？" },
              { id: "ep2-sub-blacklist", assetKind: "text", startSeconds: 81, durationSeconds: 9, label: "把他们列入黑名单。" },
            ],
          },
          {
            id: "narration",
            kind: "audio",
            items: [
              { id: "ep2-audio-release", assetKind: "audio", startSeconds: 81, durationSeconds: 9, label: "雨停后的释放音效" },
            ],
          },
        ],
      },
    },
  ],
  qaPrompts: [
    "Create a 9:16 two-episode short-drama timeline and verify subtitle/audio/video paths survive restore.",
  ],
};

function frame(seconds) {
  return Math.round(seconds * fps);
}

async function readScenario() {
  if (!existsSync(scenarioPath)) return fallbackScenario;
  return JSON.parse(await readFile(scenarioPath, "utf8"));
}

function roleForTrack(kind) {
  if (kind === "text") return "subtitle";
  if (kind === "audio") return "narration";
  return "primary-video";
}

function itemForExpectation(track, item, startOffsetSeconds) {
  const base = {
    id: item.id,
    from: frame((item.startSeconds ?? 0) + startOffsetSeconds),
    durationInFrames: frame(item.durationSeconds),
    sourceNodeId: `${item.id}-source`,
    assetId: `${item.id}-asset`,
  };
  if (item.assetKind === "text" || track.kind === "text") {
    return {
      ...base,
      type: "text",
      text: item.label,
      color: "#ffffff",
      fontSize: 64,
      fontWeight: "bold",
    };
  }
  if (item.assetKind === "audio" || track.kind === "audio") {
    return { ...base, type: "audio", src: `asset://${item.id}.wav`, volume: 1 };
  }
  if (item.assetKind === "image") {
    return { ...base, type: "image", src: `asset://${item.id}.png` };
  }
  return { ...base, type: "video", src: `asset://${item.id}.mp4`, volume: 1 };
}

function shouldUseEpisodeLocalTiming(episode) {
  const starts = (episode.timelineExpectation?.tracks ?? []).flatMap((track) =>
    (track.items ?? []).map((item) => item.startSeconds),
  ).filter((value) => typeof value === "number");
  if (starts.length === 0) return true;
  const durationSeconds = episode.durationSeconds;
  if (typeof durationSeconds !== "number" || durationSeconds <= 0) return false;
  return Math.max(...starts) <= durationSeconds;
}

function timelineFromScenario(scenario) {
  const trackMap = new Map();
  let episodeOffsetSeconds = 0;
  for (const episode of scenario.episodes ?? []) {
    const startOffsetSeconds = shouldUseEpisodeLocalTiming(episode) ? episodeOffsetSeconds : 0;
    for (const track of episode.timelineExpectation?.tracks ?? []) {
      const current = trackMap.get(track.id) ?? {
        id: track.id,
        name: track.id,
        role: roleForTrack(track.kind),
        items: [],
      };
      for (const item of track.items ?? []) {
        current.items.push(itemForExpectation(track, item, startOffsetSeconds));
      }
      trackMap.set(track.id, current);
    }
    if (typeof episode.durationSeconds === "number" && episode.durationSeconds > 0) {
      episodeOffsetSeconds += episode.durationSeconds;
    }
  }

  const tracks = [...trackMap.values()].map((track) => ({
    ...track,
    items: track.items.sort((a, b) => a.from - b.from),
  }));
  const durationInFrames = tracks.reduce((max, track) => {
    return Math.max(max, ...track.items.map((item) => item.from + item.durationInFrames));
  }, 0);

  return {
    schemaVersion: 1,
    scenarioTitle: scenario.title,
    compositionWidth: 1080,
    compositionHeight: 1920,
    fps,
    durationInFrames,
    tracks,
  };
}

function validateTimeline(timeline) {
  const issues = [];
  if (timeline.compositionWidth !== 1080 || timeline.compositionHeight !== 1920) {
    issues.push("composition must be 9:16 vertical");
  }
  const tracks = Array.isArray(timeline.tracks) ? timeline.tracks : [];
  if (tracks.length < 3) issues.push("expected at least video, subtitle, and audio tracks");
  const items = tracks.flatMap((track) => track.items ?? []);
  if (!items.some((item) => item.type === "text" && item.text)) issues.push("expected subtitle text items");
  if (!items.some((item) => item.type === "video" || item.type === "image")) issues.push("expected visual media items");
  if (!items.some((item) => item.type === "audio")) issues.push("expected audio items");
  for (const item of items) {
    if (!Number.isInteger(item.from) || item.from < 0) issues.push(`invalid from for ${item.id}`);
    if (!Number.isInteger(item.durationInFrames) || item.durationInFrames <= 0) {
      issues.push(`invalid duration for ${item.id}`);
    }
  }
  return issues;
}

async function main() {
  await mkdir(path.dirname(createdTimelinePath), { recursive: true });
  await mkdir(path.dirname(restoredTimelinePath), { recursive: true });
  const scenario = await readScenario();
  const timeline = timelineFromScenario(scenario);
  const createdIssues = validateTimeline(timeline);
  if (createdIssues.length > 0) {
    throw new Error(`Created timeline failed validation: ${createdIssues.join("; ")}`);
  }

  await writeFile(path.join(artifactRoot, "scenario.json"), JSON.stringify(scenario, null, 2));
  await writeFile(createdTimelinePath, JSON.stringify(timeline, null, 2));

  const restored = JSON.parse(await readFile(createdTimelinePath, "utf8"));
  const restoredIssues = validateTimeline(restored);
  if (restoredIssues.length > 0) {
    throw new Error(`Restored timeline failed validation: ${restoredIssues.join("; ")}`);
  }
  await writeFile(restoredTimelinePath, JSON.stringify(restored, null, 2));

  const report = {
    status: "pass",
    artifactRoot,
    scenarioPath,
    createdTimelinePath,
    restoredTimelinePath,
    title: timeline.scenarioTitle,
    episodeCount: scenario.episodes?.length ?? 0,
    trackCount: timeline.tracks.length,
    itemCount: timeline.tracks.reduce((count, track) => count + track.items.length, 0),
    durationInFrames: timeline.durationInFrames,
    durationSeconds: timeline.durationInFrames / fps,
    checks: [
      "created timeline JSON validates",
      "restored timeline JSON validates",
      "9:16 composition is preserved",
      "video/image/audio/text tracks are present",
    ],
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log("[short-drama-timeline] report", reportPath);
  console.log("[short-drama-timeline] createdTimelinePath", createdTimelinePath);
  console.log("[short-drama-timeline] restoredTimelinePath", restoredTimelinePath);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
