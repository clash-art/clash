import {
  codexQualityJudgeSupportsRequest,
  runCodexQualityJudge,
} from "./quality-review-codex";
import {
  geminiQualityJudgeSupportsRequest,
  runGeminiQualityJudge,
} from "./quality-review-gemini";
import type {
  ArtifactEvidence,
  BenchmarkQualityReviewer,
  QualityReviewRequest,
  QualityReviewResult,
} from "./types";

export function qualityJudgeSupportsRequest(
  reviewer: BenchmarkQualityReviewer,
  request: QualityReviewRequest,
): boolean {
  return reviewer.adapter === "gemini"
    ? geminiQualityJudgeSupportsRequest(request)
    : codexQualityJudgeSupportsRequest(request);
}

export async function runQualityJudge(input: {
  reviewer: BenchmarkQualityReviewer;
  request: QualityReviewRequest;
  evidence: ArtifactEvidence[];
  workspace: string;
  caseRoot: string;
}): Promise<QualityReviewResult | undefined> {
  const { reviewer, ...rest } = input;
  return reviewer.adapter === "gemini"
    ? await runGeminiQualityJudge({ reviewer, ...rest })
    : await runCodexQualityJudge({ reviewer, ...rest });
}
