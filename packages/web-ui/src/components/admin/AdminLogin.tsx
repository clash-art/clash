/**
 * Admin console sign-in (#394): an admin account's email and password,
 * checked by the admin Better Auth instance (/api/admin-auth). It is not the
 * product login: a product account cannot sign in here, and signing in here
 * does not sign in to the product. Failures show the coded reason (wrong
 * credentials, disabled account, too many attempts).
 */
import { useState } from "react";
import { ShieldCheck } from "@phosphor-icons/react";

import { adminAuthApi } from "../../lib/adminClient";
import { Button } from "../ui/button";
import { AdminErrorAlert, AdminField, useAdminAction } from "./AdminKit";

export function AdminLogin({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const action = useAdminAction(onSignedIn);
  return (
    <main className="flex min-h-screen items-center justify-center bg-warm-page px-6 text-slate-950 dark:text-slate-50">
      <section className="w-full max-w-sm space-y-4 rounded-2xl border border-warm-border bg-warm-surface/80 p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <ShieldCheck size={22} weight="duotone" className="text-red-500" />
          <h1 className="font-display text-xl font-semibold tracking-tight">Gateway admin sign-in</h1>
        </div>
        <p className="text-sm text-stone-600 dark:text-stone-300">Use your admin account. Product accounts cannot sign in here.</p>
        <AdminErrorAlert error={action.error} />
        <form
          aria-label="Admin sign-in"
          className="grid gap-3"
          onSubmit={action.submit(async () => {
            await adminAuthApi.signIn(email.trim(), password);
            setPassword("");
          })}
        >
          <AdminField label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <AdminField
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <Button type="submit" variant="primary" disabled={action.pending || !email.trim() || !password}>
            Sign in
          </Button>
        </form>
      </section>
    </main>
  );
}
