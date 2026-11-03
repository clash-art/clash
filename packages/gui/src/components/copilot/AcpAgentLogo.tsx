import {
  AgentBrandIcon,
  normalizeAgentBrandId,
} from "@openma/common/chat-ui";

type AcpAgentLogoProps = {
  agentId?: string | null;
  className?: string;
  title?: string;
  iconUrl?: string | null;
};

/**
 * Clash harness brand mark — delegates to `@openma/common` AgentBrandIcon
 * so dsh-acp / DeepSeek (and other known harnesses) share Backchat marks.
 */
export function AcpAgentLogo({
  agentId,
  className = "h-3.5 w-3.5",
  title,
  iconUrl,
}: AcpAgentLogoProps) {
  return (
    <AgentBrandIcon
      agentId={agentId}
      className={className}
      title={title}
      iconUrl={iconUrl}
      // Keep Clash test attribute aliases via data on the common SVG.
    />
  );
}

export { normalizeAgentBrandId };
