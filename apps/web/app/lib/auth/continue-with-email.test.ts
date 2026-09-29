import { describe, expect, it, vi } from "vitest";
import { continueWithEmail } from "./continue-with-email";

const credentials = { email: "creator@example.test", password: "a-password" };
function client() {
  return {
    signIn: {
      email: vi.fn(
        async () =>
          ({ error: null }) as {
            error: null | { code: string; message: string };
          },
      ),
    },
    signUp: {
      email: vi.fn(
        async () =>
          ({ error: null }) as {
            error: null | { code: string; message: string };
          },
      ),
    },
  };
}
describe("unified email access", () => {
  it("signs in existing accounts without registering", async () => {
    const auth = client();
    await continueWithEmail(auth, credentials);
    expect(auth.signUp.email).not.toHaveBeenCalled();
  });
  it("creates a new account when credentials do not resolve", async () => {
    const auth = client();
    auth.signIn.email.mockResolvedValue({
      error: {
        code: "INVALID_EMAIL_OR_PASSWORD",
        message: "Invalid credentials",
      },
    });
    await continueWithEmail(auth, credentials);
    expect(auth.signUp.email).toHaveBeenCalledWith({
      ...credentials,
      name: "creator",
    });
  });
  it("keeps wrong passwords as an error for existing accounts", async () => {
    const auth = client();
    auth.signIn.email.mockResolvedValue({
      error: {
        code: "INVALID_EMAIL_OR_PASSWORD",
        message: "Invalid credentials",
      },
    });
    auth.signUp.email.mockResolvedValue({
      error: {
        code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
        message: "Already exists",
      },
    });
    await expect(continueWithEmail(auth, credentials)).rejects.toThrow(
      "Invalid credentials",
    );
  });
  it("does not register after rate limiting", async () => {
    const auth = client();
    auth.signIn.email.mockResolvedValue({
      error: { code: "TOO_MANY_REQUESTS", message: "Try later" },
    });
    await expect(continueWithEmail(auth, credentials)).rejects.toThrow(
      "Try later",
    );
    expect(auth.signUp.email).not.toHaveBeenCalled();
  });
  it("does not register after a network failure", async () => {
    const auth = client();
    auth.signIn.email.mockRejectedValue(new Error("Offline"));
    await expect(continueWithEmail(auth, credentials)).rejects.toThrow(
      "Offline",
    );
    expect(auth.signUp.email).not.toHaveBeenCalled();
  });
});
