import { createComposerDraftStore } from "@openma/common/chat-ui";
import type { CopilotProjectAssetReference } from "@clash/shared-types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { projectAssetMention } from "./projectAssetReferences";

export interface CopilotAssetReferenceRequest {
  id: string;
  projectId: string;
  threadId: string;
  asset: CopilotProjectAssetReference;
}

const EMPTY_REQUESTS: readonly CopilotAssetReferenceRequest[] = [];

/** Shared drafts survive lazy editor mounting; references never submit a prompt. */
export function useCopilotComposerDraft({
  projectId,
  threadId,
  initialPrompt,
  requests = EMPTY_REQUESTS,
  onConsumed,
}: {
  projectId: string;
  threadId: string;
  initialPrompt?: string;
  requests?: readonly CopilotAssetReferenceRequest[];
  onConsumed?: (ids: string[]) => void;
}) {
  const drafts = useMemo(() => {
    let storage: Storage | undefined;
    try {
      storage = window.localStorage;
    } catch {
      /* memory-only draft */
    }
    return createComposerDraftStore({
      namespace: "clash.project-composer",
      storage,
    });
  }, []);
  const scope = `${projectId}:${threadId || "new"}`;
  const [state, setState] = useState(() => {
    const value = initialPrompt ?? drafts.read(scope);
    if (initialPrompt !== undefined) drafts.write(scope, value);
    return { scope, value };
  });
  const setInput = useCallback(
    (value: string) => {
      drafts.write(scope, value);
      setState({ scope, value });
    },
    [drafts, scope],
  );
  const consumed = useRef(new Set<string>());
  useEffect(() => {
    const matching = requests.filter(
      (request) =>
        request.projectId === projectId &&
        request.threadId === threadId &&
        !consumed.current.has(request.id),
    );
    if (matching.length === 0) return;
    const mentions = matching.map(({ asset }) =>
      projectAssetMention(asset.label, asset.projectAssetId),
    );
    const current = drafts.read(scope);
    setInput(
      `${current}${current && !/\s$/.test(current) ? " " : ""}${mentions.join(" ")} `,
    );
    for (const request of matching) consumed.current.add(request.id);
    onConsumed?.(matching.map(({ id }) => id));
  }, [drafts, onConsumed, projectId, requests, scope, setInput, threadId]);
  return {
    input: state.scope === scope ? state.value : drafts.read(scope),
    setInput,
  };
}
