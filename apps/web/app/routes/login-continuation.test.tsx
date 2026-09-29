// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router";
import LoginRoute from "./login";
const auth = vi.hoisted(() => ({
  email: vi.fn(
    async () =>
      ({ error: null }) as { error: null | { code: string; message: string } },
  ),
  signup: vi.fn(async () => ({ error: null })),
  update: vi.fn(async () => ({ error: null })),
}));
vi.mock("@clash/web-ui/lib/betterAuthClient", () => ({
  default: {
    useSession: () => ({ data: null }),
    signIn: { email: auth.email },
    signUp: { email: auth.signup },
    updateUser: auth.update,
  },
}));
vi.mock("@clash/gui/components/Background", () => ({ default: () => null }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  auth.email.mockResolvedValue({ error: null });
  vi.unstubAllGlobals();
});
function Location() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname + location.search}
    </output>
  );
}
it("returns password login to the pending browser authorization", async () => {
  const destination = "/auth/cli?state=original&code_challenge=challenge";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ password: true, emailOtp: false, google: false }),
    ),
  );
  render(
    <MemoryRouter
      initialEntries={["/login?returnTo=" + encodeURIComponent(destination)]}
    >
      <LoginRoute />
      <Location />
    </MemoryRouter>,
  );

  await screen.findByLabelText("Email");
  expect(screen.queryByRole("button", { name: /Google/ })).toBeNull();
  fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
    target: { value: "owner@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "password123" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(screen.getByTestId("location").textContent).toBe(destination),
  );
  expect(auth.email).toHaveBeenCalledWith({
    email: "owner@example.com",
    password: "password123",
  });
});

it("separates configured quick sign-in from password sign-in", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ password: true, emailOtp: true, google: true }),
    ),
  );
  render(
    <MemoryRouter>
      <LoginRoute />
    </MemoryRouter>,
  );
  await screen.findByRole("button", { name: "Continue with Google" });
  expect(screen.queryByLabelText("Password")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Use email and password" }),
  );
  await screen.findByLabelText("Password");
  expect(
    screen.queryByRole("button", { name: "Continue with Google" }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Back to quick sign-in" }),
  );
  await screen.findByRole("button", { name: "Continue with Google" });
  expect(screen.queryByLabelText("Password")).toBeNull();
});

it("asks only newly created accounts for a name before continuing", async () => {
  auth.email.mockResolvedValueOnce({
    error: {
      code: "INVALID_EMAIL_OR_PASSWORD",
      message: "Invalid credentials",
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ password: true, emailOtp: false, google: false }),
    ),
  );
  render(
    <MemoryRouter initialEntries={["/login"]}>
      <LoginRoute />
      <Location />
    </MemoryRouter>,
  );
  fireEvent.change(await screen.findByLabelText("Email"), {
    target: { value: "new@example.test" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "long-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.change(await screen.findByLabelText("Name"), {
    target: { value: "New Creator" },
  });
  expect(screen.getByTestId("location").textContent).toBe("/login");
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(auth.update).toHaveBeenCalledWith({ name: "New Creator" }),
  );
  await waitFor(() =>
    expect(screen.getByTestId("location").textContent).toBe("/"),
  );
});
