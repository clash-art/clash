/**
 * Accept a team invite (#354): shows the team and role the link offers and
 * joins on confirmation. The server checks that the signed-in account's
 * email is the invited one and that the invite is still pending; refusals
 * (expired, revoked, another account) are shown with their code.
 */
import { formatTime, AdminCard, AdminErrorAlert, useAdminAction } from "../admin/AdminKit";
import { teamApi, type Team, type TeamInvite } from "../../lib/teamClient";
import { Button } from "../ui/button";

export function TeamInviteAccept({
  token,
  invite,
  team,
  error,
  onAccepted,
}: {
  token: string;
  invite: TeamInvite | null;
  team: { tenantId: string; name: string } | null;
  /** The lookup's coded refusal, when the link cannot be used. */
  error: unknown;
  onAccepted: (team: Team) => void;
}) {
  const action = useAdminAction();
  return (
    <div className="mx-auto w-full max-w-lg space-y-4 px-4 py-12">
      <h1 className="font-display text-2xl font-semibold tracking-tight">Team invite</h1>
      {invite && team ? (
        <AdminCard className="space-y-3">
          <p className="text-sm">
            You are invited to join <strong>{team.name}</strong> as {invite.role === "owner" ? "an owner" : "a member"}.
          </p>
          <p className="text-xs text-stone-500">
            Sent to {invite.email} · expires {formatTime(invite.expiresAt)}
          </p>
          <Button
            type="button"
            variant="primary"
            disabled={action.pending}
            onClick={() =>
              void action.run(async () => {
                const { team: joined } = await teamApi.acceptInvite(token);
                onAccepted(joined);
              })
            }
          >
            Join {team.name}
          </Button>
          <AdminErrorAlert error={action.error} />
        </AdminCard>
      ) : (
        <AdminErrorAlert error={error ?? new Error("This invite link is not valid.")} />
      )}
    </div>
  );
}
