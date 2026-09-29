import {
  StoryboardViewStateSchema,
  type StoryboardViewState,
} from "@clash/shared-types";

/** useLoroSync.updateNode accepts a framework node patch, not a data-only patch. */
export function saveStoryboardViewState(
  updateNode: (nodeId: string, patch: Record<string, unknown>) => boolean,
  nodeId: string,
  state: StoryboardViewState,
): boolean {
  return updateNode(nodeId, {
    data: {
      state: JSON.parse(JSON.stringify(StoryboardViewStateSchema.parse(state))),
    },
  });
}
