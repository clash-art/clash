/**
 * Encryption keys page (#366, #372; guide:
 * apps/docs/guide/gateway-admin.md#node-admin-listener): the key ring that
 * seals stored upstream credentials on a Node gateway. Shows the current kid,
 * the kids this node holds and how many envelopes each kid seals; rotating
 * switches the kid new envelopes use, and resealing moves old envelopes onto
 * it in batches. Key ids and counts only: no key material is ever shown or sent.
 */
import { useState } from "react";

import { adminApi, type EncryptionKeyRing } from "../../lib/adminClient";
import { Button } from "../ui/button";
import { SelectMenu } from "../ui/select";
import { AdminCard, AdminErrorAlert, AdminSection, AdminTable, StatusPill, useAdminAction } from "./AdminKit";

export function AdminEncryption({ ring, canRotate, onChanged }: { ring: EncryptionKeyRing; canRotate: boolean; onChanged: () => void }) {
  const candidates = ring.ringKids.filter((kid) => kid !== ring.current);
  const [kid, setKid] = useState(candidates[0] ?? "");
  const [result, setResult] = useState<string | null>(null);
  const action = useAdminAction(onChanged);
  const stale = ring.envelopes.filter((row) => row.kid !== ring.current).reduce((sum, row) => sum + row.count, 0);

  return (
    <>
      <AdminErrorAlert error={action.error} />
      <AdminSection
        title="Key ring"
        description="New upstream credentials are sealed under the current key. Deploy a new key to every node's ring before rotating to it."
      >
        <AdminCard className="space-y-2 text-sm">
          <div>
            <span className="text-stone-500">Current key </span>
            {ring.current ? <code className="text-xs">{ring.current}</code> : <StatusPill tone="warn">None set</StatusPill>}
          </div>
          <div>
            <span className="text-stone-500">Keys on this node </span>
            {ring.ringKids.map((ringKid) => (
              <code key={ringKid} className="mr-2 text-xs">
                {ringKid}
              </code>
            ))}
          </div>
        </AdminCard>
        {canRotate && candidates.length > 0 ? (
          <AdminCard>
            <form
              aria-label="Rotate key"
              className="flex flex-wrap items-end gap-3"
              onSubmit={action.submit(async () => {
                const rotated = await adminApi.rotateEncryption(kid);
                setResult(`New credentials are sealed under ${rotated.current}.`);
              })}
            >
              <label className="flex flex-col gap-1 text-xs font-medium text-stone-600 dark:text-stone-300">
                <span>New current key</span>
                <SelectMenu
                  ariaLabel="New current key"
                  variant="field"
                  size="sm"
                  value={kid}
                  options={candidates.map((value) => ({ value, label: value }))}
                  onValueChange={setKid}
                />
              </label>
              <Button type="submit" size="sm" variant="primary" disabled={action.pending || !kid}>
                Rotate
              </Button>
            </form>
          </AdminCard>
        ) : null}
      </AdminSection>

      <AdminSection
        title="Sealed credentials"
        description={stale ? `${stale.toLocaleString()} sealed under an older key.` : "Every credential is sealed under the current key."}
        actions={
          canRotate && ring.current && stale ? (
            <Button
              size="sm"
              disabled={action.pending}
              onClick={() =>
                void action.run(async () => {
                  const resealed = await adminApi.reencrypt();
                  setResult(`${resealed.resealed} resealed, ${resealed.skipped} skipped, ${resealed.failed} failed.`);
                })
              }
            >
              Reseal a batch
            </Button>
          ) : null
        }
      >
        {result ? <p className="text-sm text-stone-500">{result}</p> : null}
        <AdminTable
          label="Sealed credentials"
          rows={ring.envelopes}
          rowKey={(row) => `${row.kid}:${row.scope}`}
          empty="No upstream credentials are stored."
          columns={[
            {
              header: "Key",
              cell: (row) => (
                <span className="flex items-center gap-2">
                  <code className="text-xs">{row.kid}</code>
                  {row.kid === ring.current ? <StatusPill tone="ok">current</StatusPill> : null}
                </span>
              ),
            },
            { header: "Scope", cell: (row) => row.scope },
            { header: "Credentials", cell: (row) => row.count.toLocaleString(), align: "right" },
          ]}
        />
      </AdminSection>
    </>
  );
}
