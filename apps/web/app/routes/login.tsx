import "./login.css";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { GoogleLogo, ArrowLeft } from "@phosphor-icons/react";
import betterAuthClient from "@clash/web-ui/lib/betterAuthClient";
import { runtimeApiUrl } from "@clash/web-ui/lib/runtimeConfig";
import { Button } from "@clash/gui/components/ui/button";
import { Input } from "@clash/gui/components/ui/input";
import { InlineAlert } from "@clash/gui/components/ui/feedback";
import { BrandAsset } from "@clash/web-ui/components/BrandAsset";
import { continueWithEmail } from "../lib/auth/continue-with-email";
import { loginReturnPath } from "../lib/auth/login-return";

type Methods = { password: boolean; emailOtp: boolean; google: boolean };
type Stage = "name" | "quick" | "signin" | "email" | "code";
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Could not connect. Please try again.";

export default function LoginRoute() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const returnTo = loginReturnPath(params.get("returnTo"));
  const desktop = returnTo.startsWith("/auth/cli?");
  const session = betterAuthClient.useSession();
  const [methods, setMethods] = useState<Methods | null>(null);
  const [reload, setReload] = useState(0);
  const [stage, setStage] = useState<Stage>("signin");
  const reduceMotion = useReducedMotion();
  const [direction, setDirection] = useState(1);
  const panelRef = useRef<HTMLDivElement>(null);
  const focusAfterSwitch = useRef(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const needsName = useRef(false);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (session.data?.user && !inFlight.current && !needsName.current)
      navigate(returnTo, { replace: true });
  }, [session.data, navigate, returnTo]);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setError(null);
    void fetch(runtimeApiUrl("/api/better-auth/options"), {
      signal: controller.signal,
      credentials: "include",
    })
      .then(async (response) => {
        if (!response.ok) throw Error("Sign-in is unavailable. Please retry.");
        const value = (await response.json()) as Partial<Methods>;
        if (
          typeof value.password !== "boolean" ||
          typeof value.emailOtp !== "boolean" ||
          typeof value.google !== "boolean"
        )
          throw Error("This service needs an update before you can sign in.");
        if (active) {
          setMethods(value as Methods);
          setStage(
            value.emailOtp ? "email" : value.google ? "quick" : "signin",
          );
        }
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [reload]);
  useEffect(() => {
    if (stage !== "code") return;
    codeInput.current?.focus();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [stage]);
  const changeStage = (next: Stage) => {
    setDirection(next === "email" || next === "quick" ? -1 : 1);
    focusAfterSwitch.current =
      panelRef.current?.contains(document.activeElement) === true;
    setStage(next);
    setError(null);
    setPassword("");
    setCode("");
  };
  const run = async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const sendCode = async () => {
    const result = await betterAuthClient.emailOtp.sendVerificationOtp({
      email: email.trim(),
      type: "sign-in",
    });
    if (result.error)
      throw Error(result.error.message || "Could not send a code.");
    setCode("");
    setStage("code");
    setNow(Date.now());
    setResendAt(Date.now() + 60000);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      if (stage === "name") {
        if (!name.trim()) throw Error("Please enter your name.");
        const result = await betterAuthClient.updateUser({ name: name.trim() });
        if (result.error)
          throw Error(
            result.error.message || "Could not save your name. Please retry.",
          );
        needsName.current = false;
        navigate(returnTo, { replace: true });
        return;
      }
      if (stage === "email") {
        await sendCode();
        return;
      }
      if (stage === "code") {
        const result = await betterAuthClient.signIn.emailOtp({
          email: email.trim(),
          otp: code,
        });
        if (result.error)
          throw Error(result.error.message || "Could not verify your code.");
      } else {
        const result = await continueWithEmail(betterAuthClient, {
          email: email.trim(),
          password,
        });
        if (result.created) {
          needsName.current = true;
          changeStage("name");
          return;
        }
      }
      navigate(returnTo, { replace: true });
    });
  };
  const seconds = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const heading =
    stage === "name"
      ? "What should we call you?"
      : stage === "code"
        ? "Check your email"
        : "Continue to Clash";
  const linkClass =
    "border-0 bg-transparent p-0 text-sm shadow-none hover:bg-transparent underline-offset-4 hover:underline";
  return (
    <main className="login-page bg-background text-foreground">
      <div className="login-layout bg-background">
        <aside className="login-art" aria-label="Clash creative workspace">
          <img
            src="/art/login-frames-to-film-dark.webp"
            alt="Colorful glass frames coming together into a continuous film strip."
            className="login-art-image"
            width="1086"
            height="1448"
          />
        </aside>
        <section aria-label="Your Clash account" className="login-form-panel">
          <div className="login-form-content">
            <Link
              to="/"
              aria-label="Clash home"
              className="login-brand items-center gap-2 font-display text-xl font-semibold"
            >
              <BrandAsset name="mark" alt="" className="size-8" />
              Clash
            </Link>
            <motion.div
              layout="size"
              transition={{ duration: reduceMotion ? 0 : 0.24 }}
              style={{ overflow: "hidden", padding: 4, margin: -4 }}
            >
              <AnimatePresence initial={false} mode="wait" custom={direction}>
                <motion.div
                  key={methods ? stage : "loading"}
                  ref={panelRef}
                  custom={direction}
                  variants={{
                    enter: (d: number) => ({
                      opacity: reduceMotion ? 1 : 0,
                      x: reduceMotion ? 0 : d * 14,
                    }),
                    visible: { opacity: 1, x: 0 },
                    leave: (d: number) => ({
                      opacity: reduceMotion ? 1 : 0,
                      x: reduceMotion ? 0 : -d * 10,
                    }),
                  }}
                  initial="enter"
                  animate="visible"
                  exit="leave"
                  transition={{
                    duration: reduceMotion ? 0 : 0.18,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                  onAnimationComplete={(definition) => {
                    if (definition === "visible" && focusAfterSwitch.current) {
                      panelRef.current
                        ?.querySelector<HTMLElement>("h1")
                        ?.focus({ preventScroll: true });
                      focusAfterSwitch.current = false;
                    }
                  }}
                >
                  <h1
                    tabIndex={-1}
                    className="font-display text-3xl font-semibold tracking-tight outline-none"
                  >
                    {heading}
                  </h1>
                  <p className="mt-1 text-sm leading-5 text-muted-foreground">
                    {stage === "name" ? (
                      "Your account is ready. Add your name to finish."
                    ) : stage === "code" ? (
                      <>
                        Enter the code sent to{" "}
                        <strong className="break-all font-medium text-foreground">
                          {email.trim()}
                        </strong>
                        .
                      </>
                    ) : desktop ? (
                      "Sign in to connect your desktop app. Your local projects stay local until you enable sync."
                    ) : (
                      "Sign in or create an account to start creating."
                    )}
                  </p>
                  {error && (!methods || stage === "quick") ? (
                    <InlineAlert
                      tone="error"
                      title="Couldn't continue"
                      message={error}
                      className="mt-6"
                    />
                  ) : null}
                  {!methods ? (
                    <div className="mt-8">
                      {error ? (
                        <Button onClick={() => setReload((value) => value + 1)}>
                          Retry connection
                        </Button>
                      ) : (
                        <p
                          role="status"
                          className="text-sm text-muted-foreground"
                        >
                          Loading sign-in options…
                        </p>
                      )}
                    </div>
                  ) : (
                    <>
                      {methods.google &&
                      (stage === "quick" || stage === "email") ? (
                        <>
                          <Button
                            disabled={busy}
                            className="mt-5 min-h-11 w-full"
                            onClick={() =>
                              void run(async () => {
                                const result =
                                  await betterAuthClient.signIn.social({
                                    provider: "google",
                                    callbackURL: returnTo,
                                  });
                                if (result.error)
                                  throw Error(
                                    result.error.message ||
                                      "Google sign-in failed.",
                                  );
                              })
                            }
                          >
                            <GoogleLogo size={20} />
                            Continue with Google
                          </Button>
                          {methods.emailOtp ? (
                            <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground">
                              <span className="h-px flex-1 bg-border" />
                              or use email
                              <span className="h-px flex-1 bg-border" />
                            </div>
                          ) : null}
                        </>
                      ) : null}
                      {stage === "name" ||
                      (methods.password && stage === "signin") ||
                      (methods.emailOtp &&
                        (stage === "email" || stage === "code")) ? (
                        <form
                          onSubmit={submit}
                          className="mt-5 space-y-3"
                          aria-label={heading}
                          aria-busy={busy}
                        >
                          <fieldset disabled={busy} className="space-y-3">
                            {stage !== "code" && stage !== "name" ? (
                              <div className="space-y-1.5">
                                <label
                                  htmlFor="login-email"
                                  className="text-sm font-medium"
                                >
                                  Email
                                </label>
                                <Input
                                  id="login-email"
                                  type="email"
                                  autoComplete="email"
                                  placeholder="you@example.com"
                                  value={email}
                                  onChange={(event) =>
                                    setEmail(event.target.value)
                                  }
                                  required
                                  className="min-h-11 w-full"
                                />
                              </div>
                            ) : null}
                            {stage === "name" ? (
                              <div className="space-y-1.5">
                                <label
                                  htmlFor="login-name"
                                  className="text-sm font-medium"
                                >
                                  Name
                                </label>
                                <Input
                                  id="login-name"
                                  autoComplete="name"
                                  value={name}
                                  onChange={(event) =>
                                    setName(event.target.value)
                                  }
                                  required
                                  maxLength={100}
                                  className="min-h-11 w-full"
                                />
                              </div>
                            ) : null}
                            {stage === "signin" ? (
                              <div className="space-y-1.5">
                                <label
                                  htmlFor="login-password"
                                  className="text-sm font-medium"
                                >
                                  Password
                                </label>
                                <Input
                                  id="login-password"
                                  aria-invalid={stage === "signin" && !!error}
                                  aria-describedby={
                                    error ? "login-submit-error" : undefined
                                  }
                                  type="password"
                                  autoComplete="current-password"
                                  placeholder="Enter your password"
                                  value={password}
                                  onChange={(event) =>
                                    setPassword(event.target.value)
                                  }
                                  required
                                  className="min-h-11 w-full"
                                />
                              </div>
                            ) : null}
                            {stage === "code" ? (
                              <div className="space-y-1.5">
                                <label
                                  htmlFor="login-code"
                                  className="text-sm font-medium"
                                >
                                  Verification code
                                </label>
                                <Input
                                  ref={codeInput}
                                  id="login-code"
                                  inputMode="numeric"
                                  autoComplete="one-time-code"
                                  pattern="[0-9]{6}"
                                  maxLength={6}
                                  value={code}
                                  onChange={(event) =>
                                    setCode(
                                      event.target.value.replace(/\D/g, ""),
                                    )
                                  }
                                  required
                                  className="min-h-11 w-full font-mono text-lg tracking-widest"
                                />
                              </div>
                            ) : null}
                            {error ? (
                              <p
                                id="login-submit-error"
                                role="alert"
                                className="text-sm text-destructive"
                              >
                                {error}
                              </p>
                            ) : null}
                            <Button
                              type="submit"
                              variant="primary"
                              disabled={busy}
                              className="min-h-11 w-full"
                            >
                              {busy
                                ? "Please wait…"
                                : stage === "code"
                                  ? "Verify and continue"
                                  : stage === "email"
                                    ? "Send verification code"
                                    : "Continue"}
                            </Button>
                          </fieldset>
                        </form>
                      ) : !methods.google &&
                        !methods.password &&
                        !methods.emailOtp ? (
                        <p className="mt-8 text-sm">
                          Sign-in is not enabled on this service.
                        </p>
                      ) : null}
                      <div className="login-account-actions mt-3 flex flex-wrap items-center justify-center gap-4">
                        {stage === "code" ? (
                          <>
                            <Button
                              disabled={busy}
                              className={linkClass}
                              onClick={() => changeStage("email")}
                            >
                              <ArrowLeft />
                              Change email
                            </Button>
                            <Button
                              disabled={busy || seconds > 0}
                              className={linkClass}
                              onClick={() => void run(sendCode)}
                            >
                              {seconds > 0
                                ? `Resend in ${seconds}s`
                                : "Resend code"}
                            </Button>
                          </>
                        ) : (
                          <>
                            {methods.password &&
                            (stage === "email" || stage === "quick") ? (
                              <Button
                                disabled={busy}
                                className={linkClass}
                                onClick={() => changeStage("signin")}
                              >
                                Use email and password
                              </Button>
                            ) : null}
                            {(methods.emailOtp || methods.google) &&
                            stage === "signin" ? (
                              <Button
                                disabled={busy}
                                className={linkClass}
                                onClick={() =>
                                  changeStage(
                                    methods.emailOtp ? "email" : "quick",
                                  )
                                }
                              >
                                <ArrowLeft /> Back to quick sign-in
                              </Button>
                            ) : null}
                          </>
                        )}
                      </div>
                    </>
                  )}
                </motion.div>
              </AnimatePresence>
            </motion.div>
          </div>
        </section>
      </div>
    </main>
  );
}
