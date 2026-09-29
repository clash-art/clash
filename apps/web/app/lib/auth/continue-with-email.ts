type Result = { error?: { code?: string; message?: string } | null };
type Credentials = { email: string; password: string };
type EmailClient = {
  signIn: { email: (input: Credentials) => Promise<Result> };
  signUp: { email: (input: Credentials & { name: string }) => Promise<Result> };
};

/** Keep Better Auth responsible for credentials, uniqueness and sessions. */
export async function continueWithEmail(
  client: EmailClient,
  input: Credentials,
) {
  const login = await client.signIn.email(input);
  if (!login.error) return { created: false };
  // Better Auth intentionally uses the same code for absent users and bad passwords.
  if (login.error.code !== "INVALID_EMAIL_OR_PASSWORD")
    throw new Error(
      login.error.message || "Could not sign in. Please try again.",
    );
  const registration = await client.signUp.email({
    ...input,
    name: input.email.split("@")[0],
  });
  if (!registration.error) return { created: true };
  if (registration.error.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL")
    throw new Error(login.error.message || "Invalid email or password.");
  throw new Error(
    registration.error.message || "Could not create your account.",
  );
}
