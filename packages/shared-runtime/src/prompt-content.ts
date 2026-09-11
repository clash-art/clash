// ACP history may replay the separately supplied host block before user text.
// Only strip a leading complete block, leaving user quotations intact.
const CLASH_HOST_CONTEXT_PREFIX =
  /^\s*\[Clash host context — supplied by the application, not written by the user\][\s\S]*?\[\/Clash host context\]\s*/;
const CLASH_PROTOCOL_COMMENT =
  /<!--\s*clash-(?:workspace-context|agent-annotations)\b[\s\S]*?-->/g;
const LEGACY_ASSET_COMMENT = /<!--\s*asset-keys:.+?-->/g;
const LEGACY_ATTACHMENT_LABEL = /📎\s*\S+/g;

/**
 * Returns the part of a user prompt that belongs in human-facing UI such as
 * session titles. Machine-readable context still travels to the ACP, but can
 * never become the visible title or transcript label.
 */
export function visibleUserPromptText(content: string): string {
  return content
    .replace(CLASH_HOST_CONTEXT_PREFIX, "")
    .replace(CLASH_PROTOCOL_COMMENT, "")
    .replace(LEGACY_ASSET_COMMENT, "")
    .replace(LEGACY_ATTACHMENT_LABEL, "")
    .trim();
}
