import { describe, expect, it } from "vitest";

import {
  isLoopbackRemoteAddress,
  socketRemoteAddress,
} from "./loopback-client.js";

describe("loopback client address", () => {
  it.each(["127.0.0.1", "127.255.255.254", "::1", "::ffff:127.0.0.1", "::FFFF:127.8.9.10"])(
    "accepts %s",
    (address) => {
      expect(isLoopbackRemoteAddress(address)).toBe(true);
    },
  );

  it.each([
    "192.168.1.5",
    "10.0.0.1",
    "::ffff:10.0.0.1",
    "128.0.0.1",
    "1127.0.0.1",
    "127.0.0.1.evil.example",
    "127.1",
    "::",
    "fe80::1",
    "::ffff:",
    "localhost",
    "",
    undefined,
  ])("rejects %s", (address) => {
    expect(isLoopbackRemoteAddress(address)).toBe(false);
  });

  it("reads only the socket peer address", () => {
    expect(
      socketRemoteAddress({ incoming: { socket: { remoteAddress: "::1" } } }),
    ).toBe("::1");
    expect(socketRemoteAddress(undefined)).toBeUndefined();
    expect(socketRemoteAddress({})).toBeUndefined();
    expect(socketRemoteAddress({ incoming: {} })).toBeUndefined();
    expect(
      socketRemoteAddress({ incoming: { socket: { remoteAddress: 7 } } }),
    ).toBeUndefined();
  });
});
