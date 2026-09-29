import { Info } from "@phosphor-icons/react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import { Button } from "./ui/button";

/** Keep diagnostics inspectable without guessing capabilities from HTTP status. */
export function ServiceNotice({
  service,
  error,
  onRetry,
}: {
  service: string;
  error: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="status"
      className="rounded-lg border border-warm-border bg-warm-surface px-3 py-2.5 text-xs text-content-secondary"
    >
      <div className="flex items-start gap-2">
        <Info
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-content-muted"
        />
        <div className="min-w-0 flex-1">
          <p className="font-medium leading-5 text-content-primary">
            {service} unavailable
          </p>
          <p className="mt-0.5 leading-5">
            We couldn’t load this section. Your current work stays open.
          </p>
          {onRetry ? (
            <Button
              variant="default"
              size="sm"
              className="mt-1"
              onClick={onRetry}
            >
              Try again
            </Button>
          ) : null}
          <Collapsible className="mt-1.5">
            <CollapsibleTrigger className="text-xs text-content-muted underline decoration-dotted underline-offset-4 hover:text-content-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
              Technical details
            </CollapsibleTrigger>
            <CollapsibleContent>
              <p className="mt-2 break-words text-xs leading-5 text-content-secondary">
                {error}
              </p>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </div>
    </div>
  );
}
