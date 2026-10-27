/**
 * Usage explorer facts (#355): what an entry charged and the CSV encoding.
 * Expectations come from the ledger's own meaning (a settle charges, a
 * refund gives back, holds only reserve), RFC 4180 and OWASP's CSV-injection
 * guidance, never from values copied out of the module.
 */
import { describe, expect, it } from "vitest";

import {
  csvRecord,
  isUnchargedSettlement,
  ledgerChargeMicroCredits,
  usageCsvHeader,
  usageCsvRecord,
  usageExportColumns,
  type GatewayUsageEntry,
} from "./usage-export.js";

function entry(overrides: Partial<GatewayUsageEntry> = {}): GatewayUsageEntry {
  return {
    id: "row-1",
    requestId: "gwr_1",
    kind: "settle",
    status: "settled",
    tenantId: "team:t",
    userId: "u",
    keyId: null,
    budgetId: "b",
    amountMicroCredits: 7,
    chargeMicroCredits: 7,
    notCharged: false,
    modelCode: "m",
    modelKind: "text",
    credentialScope: "official",
    inputTokens: 1,
    outputTokens: 2,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    units: {},
    usageSource: "reported",
    priceVersion: "p",
    refKind: null,
    refId: null,
    upstreamId: "openai",
    errorCode: null,
    reason: null,
    occurredAt: "2026-10-24T00:00:00.000Z",
    ...overrides,
  };
}

/** RFC 4180 reader for the records these tests produce (quoted fields, doubled quotes). */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\r" && text[index + 1] === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      index += 1;
    } else field += char;
  }
  return records;
}

describe("ledger charge", () => {
  it("charges a settlement its amount, gives a refund back, and charges nothing for reservations or wallet moves", () => {
    const amount = 1234;
    expect(ledgerChargeMicroCredits({ kind: "settle", amountMicroCredits: amount })).toBe(amount);
    expect(ledgerChargeMicroCredits({ kind: "refund", amountMicroCredits: amount })).toBe(-amount);
    for (const kind of ["hold", "release", "adjust", "grant", "topup", "expire"])
      expect(ledgerChargeMicroCredits({ kind, amountMicroCredits: amount }), kind).toBe(0);
  });

  it("marks a failed or expired request settled at zero as not charged, and nothing else", () => {
    for (const status of ["upstream_failed", "gateway_failed", "expired", "client_aborted", "partial"])
      expect(isUnchargedSettlement({ kind: "settle", status, amountMicroCredits: 0 }), status).toBe(true);
    // A completion that used nothing billable is charged zero, not "not charged".
    expect(isUnchargedSettlement({ kind: "settle", status: "settled", amountMicroCredits: 0 })).toBe(false);
    expect(isUnchargedSettlement({ kind: "settle", status: "partial", amountMicroCredits: 5 })).toBe(false);
    expect(isUnchargedSettlement({ kind: "hold", status: "released", amountMicroCredits: 0 })).toBe(false);
  });
});

describe("usage CSV", () => {
  it("writes CRLF records and quotes commas, quotes and line breaks (RFC 4180)", () => {
    const text = csvRecord(["a,b", 'say "hi"', "line\nbreak", "plain", 3, null]);
    expect(text.endsWith("\r\n")).toBe(true);
    expect(parseCsv(text)).toEqual([["a,b", 'say "hi"', "line\nbreak", "plain", "3", ""]]);
  });

  it("neutralises text cells a spreadsheet would evaluate as a formula, but keeps numbers numeric", () => {
    const [record] = parseCsv(csvRecord(["=HYPERLINK(1)", "+1", "-x", "@sum", -5]));
    for (const cell of record!.slice(0, 4)) expect(cell.startsWith("'")).toBe(true);
    expect(record![4]).toBe("-5");
  });

  it("has one header cell per record cell, and a record per entry that round-trips its fields", () => {
    const value = entry({ reason: 'note, with "quotes"', units: { image: 2 } });
    const [header] = parseCsv(usageCsvHeader());
    const [record] = parseCsv(usageCsvRecord(value));
    expect(record).toHaveLength(header!.length);
    const row = Object.fromEntries(header!.map((name, index) => [name, record![index]]));
    expect(row.request_id).toBe(value.requestId);
    expect(row.reason).toBe(value.reason);
    expect(JSON.parse(row.units!)).toEqual(value.units);
    expect(Number(row.charge_micro_credits)).toBe(value.chargeMicroCredits);
  });

  it("never shows a team the upstream that served its requests", () => {
    const value = entry({ upstreamId: "upstream-secretive" });
    const [header] = parseCsv(usageCsvHeader("tenant"));
    expect(header).not.toContain("upstream_id");
    expect(usageCsvRecord(value, "tenant")).not.toContain(value.upstreamId);
    expect(usageCsvRecord(value, "platform")).toContain(value.upstreamId);
    expect(usageExportColumns("tenant").length).toBe(header!.length);
  });
});
