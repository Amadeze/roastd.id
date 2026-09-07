import { describe, expect, it, vi, beforeEach } from "vitest";

const TENANT_ID = "tenant-gl-1";

vi.mock("@/lib/auth", () => ({
  requireFeature: vi.fn().mockResolvedValue(undefined),
  requireRole: vi.fn().mockResolvedValue({ tenantId: TENANT_ID }),
  requireTenantPrisma: vi.fn(),
  getCurrentTenantId: vi.fn().mockResolvedValue(TENANT_ID),
  getTenantTimezone: vi.fn().mockResolvedValue("Asia/Jakarta"),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const { requireTenantPrisma } = await import("@/lib/auth");
const { getGlIntegrityCheck } = await import("./actions");

type LineGroup = {
  journalEntryId: string;
  _sum: { debit: unknown; credit: unknown };
};

function fakeTenantPrisma(lineGroups: LineGroup[], emptyEntries: { code: string }[] = []) {
  const unbalanced = lineGroups.filter(
    (g) => Math.abs(Number(g._sum.debit ?? 0) - Number(g._sum.credit ?? 0)) > 0.01,
  );
  const unbalancedIds = unbalanced.map((g) => g.journalEntryId);
  return {
    journalLine: {
      groupBy: vi.fn().mockResolvedValue(lineGroups),
    },
    journalEntry: {
      findMany: vi.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) => {
        if (where && "lines" in where) {
          return Promise.resolve(emptyEntries);
        }
        const ids = (where.id as { in: string[] }).in;
        return Promise.resolve(
          ids.map((id) => ({ id, code: `JE-${id}` })),
        );
      }),
    },
    account: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // Sanity: unbalanced probe must only fire when there are offending ids.
    _unbalancedIds: unbalancedIds,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getGlIntegrityCheck", () => {
  it("flags unbalanced entries from SQL-side sums without loading entries", async () => {
    const tp = fakeTenantPrisma([
      { journalEntryId: "e1", _sum: { debit: 100, credit: 100 } },
      { journalEntryId: "e2", _sum: { debit: 250, credit: 200 } },
    ]);
    (requireTenantPrisma as any).mockResolvedValue(tp);

    const issues = await getGlIntegrityCheck();

    const unbalanced = issues.filter((i) => i.category === "UNBALANCED_ENTRY");
    expect(unbalanced).toHaveLength(1);
    expect(unbalanced[0].entryCode).toBe("JE-e2");
    expect(unbalanced[0].detail).toContain("50.00");
    // The empty-entry probe must not report anything for balanced ledgers.
    expect(issues.filter((i) => i.category === "EMPTY_ENTRY")).toHaveLength(0);
  });

  it("reports entries without lines", async () => {
    const tp = fakeTenantPrisma(
      [{ journalEntryId: "e1", _sum: { debit: 10, credit: 10 } }],
      [{ code: "JE-EMPTY" }],
    );
    (requireTenantPrisma as any).mockResolvedValue(tp);

    const issues = await getGlIntegrityCheck();

    const empty = issues.filter((i) => i.category === "EMPTY_ENTRY");
    expect(empty).toHaveLength(1);
    expect(empty[0].entryCode).toBe("JE-EMPTY");
  });

  it("skips the per-entry lookup when all entries balance", async () => {
    const tp = fakeTenantPrisma([
      { journalEntryId: "e1", _sum: { debit: 100, credit: 100 } },
    ]);
    (requireTenantPrisma as any).mockResolvedValue(tp);

    await getGlIntegrityCheck();

    const entryFindMany = tp.journalEntry.findMany as any;
    // Only the empty-entry probe runs; no id-lookup for unbalanced entries.
    expect(entryFindMany).toHaveBeenCalledTimes(1);
    expect(tp._unbalancedIds).toHaveLength(0);
  });
});
