import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { NextRequest } from "next/server";
import { getIronSession } from "iron-session";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { SESSION_OPTIONS, type SessionUser } from "@/lib/session";
import { POST } from "./route";

// Gated integration test: only runs against an isolated test DB with RUN_INTEGRATION=true.
const integrationEnabled = process.env.RUN_INTEGRATION === "true";
const suite = integrationEnabled ? describe : describe.skip;

// In-memory cookie jar standing in for next/headers cookies() so the real
// iron-session + getValidatedCurrentUser chain runs against real sessions.
const authEnv = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    cookieStore: {
      get: (name: string) => {
        const value = store.get(name);
        return value === undefined ? undefined : { name, value };
      },
      set: (name: string, value: string) => {
        store.set(name, value);
      },
      delete: (name: string) => {
        store.delete(name);
      },
    },
  };
});

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => authEnv.cookieStore),
  headers: vi.fn(async () => ({})),
}));

// iron-session 8.x does not export its CookieStore type; mirror its shape.
interface CookieStoreLike {
  get(name: string): { name: string; value: string } | undefined;
  set: {
    (name: string, value: string, cookie?: unknown): void;
    (options: unknown): void;
  };
  delete(name: string): void;
}

const TENANT_A = "tenant-manual-a";
const TENANT_B = "tenant-manual-b";
const USER_A = "user-manual-a";
const USER_A_DISABLED = "user-manual-a-disabled";
const MACHINE_A_ACTIVE = "machine-manual-a-active";
const MACHINE_A_INACTIVE = "machine-manual-a-inactive";
const MACHINE_B = "machine-manual-b";
const CONNECTOR_A = "connector-manual-a-real";

const fixturesDir = join(process.cwd(), "src/lib/artisan/__tests__/fixtures");

suite("manual roasting upload machine ownership (integration)", () => {
  beforeAll(async () => {
    for (const [id, code, subdomain] of [
      [TENANT_A, "MNLA", "mnl-a"],
      [TENANT_B, "MNLB", "mnl-b"],
    ] as const) {
      await prisma.tenant.create({
        data: {
          id,
          code,
          name: `ManualUpload ${code}`,
          subdomain,
          subscriptionTier: "BASIC",
          subscriptionStatus: "ACTIVE",
          isActive: true,
        },
      });
    }

    await prisma.user.createMany({
      data: [
        { id: USER_A, tenantId: TENANT_A, email: "manual-a@example.com", name: "Manual A", role: "OWNER" },
        { id: USER_A_DISABLED, tenantId: TENANT_A, email: "manual-a-disabled@example.com", name: "Manual A2", role: "OWNER" },
      ],
    });

    await prisma.machine.createMany({
      data: [
        { id: MACHINE_A_ACTIVE, tenantId: TENANT_A, name: "Mesin A Aktif", isActive: true },
        { id: MACHINE_A_INACTIVE, tenantId: TENANT_A, name: "Mesin A Nonaktif", isActive: false },
        { id: MACHINE_B, tenantId: TENANT_B, name: "Mesin B", isActive: true },
      ],
    });

    // A real Artisan/Studio connector of tenant A, used to prove connector
    // imports keep a valid connector while manual uploads store null. No
    // hidden "manual-upload" connector row is created anywhere.
    await prisma.roastdStudio.create({
      data: {
        id: CONNECTOR_A,
        tenantId: TENANT_A,
        machineId: MACHINE_A_ACTIVE,
        installationId: "11111111-1111-4111-8111-111111111111",
        computerName: "Connector A",
        platform: "windows",
        appVersion: "1.0.0",
        credentialHash: "connector-manual-a-real",
        status: "ONLINE",
        authorizedByUserId: USER_A,
      },
    });
  });

  afterAll(async () => {
    await prisma.roast.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
    await prisma.artisanRoastImport.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
    await prisma.roastdStudio.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
    await prisma.machine.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
    await prisma.user.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
    await prisma.tenant.deleteMany({
      where: { id: { in: [TENANT_A, TENANT_B] } },
    });
  });

  async function loginAs(user: { id: string; tenantId: string; email: string; name: string }) {
    const session = await getIronSession<{ user?: SessionUser }>(
      authEnv.cookieStore as unknown as CookieStoreLike,
      SESSION_OPTIONS,
    );
    session.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: "OWNER",
      tenantId: user.tenantId,
      sessionVersion: 0,
    };
    await session.save();
  }

  async function upload(machineId: string | null, fixture: "sample-roast.alog" | "sweet-marias-real.alog") {
    const buffer = readFileSync(join(fixturesDir, fixture));
    const form = new FormData();
    if (machineId) form.append("machineId", machineId);
    form.append("file", new File([buffer], fixture));
    const req = new NextRequest("http://localhost/api/roasting/manual-upload", {
      method: "POST",
      body: form,
    });
    return POST(req);
  }

  function importCount(tenantId: string, machineId?: string): Promise<number> {
    return prisma.artisanRoastImport.count({
      where: machineId
        ? { tenantId, machineId }
        : { tenantId },
    });
  }

  it("accepts a machine owned by the caller's tenant", async () => {
    authEnv.store.clear();
    await loginAs({ id: USER_A, tenantId: TENANT_A, email: "manual-a@example.com", name: "Manual A" });
    const before = await importCount(TENANT_A);

    const res = await upload(MACHINE_A_ACTIVE, "sample-roast.alog");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const importRow = await prisma.artisanRoastImport.findFirst({
      where: { tenantId: TENANT_A, machineId: MACHINE_A_ACTIVE },
      orderBy: { uploadedAt: "desc" },
    });
    expect(importRow).not.toBeNull();
    expect(importRow?.tenantId).toBe(TENANT_A);
    expect(importRow?.connectorId).toBeNull();
    expect(await importCount(TENANT_A)).toBe(before + 1);

    const roast = await prisma.roast.findUnique({
      where: { importId: importRow!.id },
    });
    expect(roast).not.toBeNull();
    expect(roast?.tenantId).toBe(TENANT_A);
    expect(roast?.machineId).toBe(MACHINE_A_ACTIVE);
  });

  it("rejects a machine owned by another tenant without writing anything", async () => {
    authEnv.store.clear();
    await loginAs({ id: USER_A, tenantId: TENANT_A, email: "manual-a@example.com", name: "Manual A" });
    const beforeA = await importCount(TENANT_A);
    const beforeB = await importCount(TENANT_B);
    const machineB = await prisma.machine.findUnique({ where: { id: MACHINE_B } });
    expect(machineB?.isActive).toBe(true);

    const res = await upload(MACHINE_B, "sample-roast.alog");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Mesin tidak ditemukan." });

    expect(await importCount(TENANT_A)).toBe(beforeA);
    expect(await importCount(TENANT_B)).toBe(beforeB);
    expect(
      await prisma.artisanRoastImport.count({ where: { machineId: MACHINE_B } }),
    ).toBe(0);
    expect(
      await prisma.roast.count({ where: { machineId: MACHINE_B } }),
    ).toBe(0);
  });

  it("rejects a nonexistent machine with the same response (no existence leak)", async () => {
    authEnv.store.clear();
    await loginAs({ id: USER_A, tenantId: TENANT_A, email: "manual-a@example.com", name: "Manual A" });
    const beforeA = await importCount(TENANT_A);
    const beforeB = await importCount(TENANT_B);

    const foreignRes = await upload(MACHINE_B, "sample-roast.alog");
    const missingRes = await upload("machine-never-exists", "sample-roast.alog");

    expect(foreignRes.status).toBe(404);
    expect(missingRes.status).toBe(404);
    await expect(foreignRes.json()).resolves.toEqual(
      await missingRes.json(),
    );

    expect(await importCount(TENANT_A)).toBe(beforeA);
    expect(await importCount(TENANT_B)).toBe(beforeB);
  });

  it("rejects a disabled machine of the caller's tenant", async () => {
    authEnv.store.clear();
    await loginAs({ id: USER_A, tenantId: TENANT_A, email: "manual-a@example.com", name: "Manual A" });

    const res = await upload(MACHINE_A_INACTIVE, "sample-roast.alog");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Mesin tidak ditemukan." });
  });

  it("rejects a disabled user before any machine processing", async () => {
    authEnv.store.clear();
    await loginAs({ id: USER_A_DISABLED, tenantId: TENANT_A, email: "manual-a-disabled@example.com", name: "Manual A2" });
    const before = await importCount(TENANT_A);

    // Active user reaches the handler (duplicate of test 1's file → 200, no row).
    const first = await upload(MACHINE_A_ACTIVE, "sample-roast.alog");
    expect(first.status).toBe(200);

    await prisma.user.update({ where: { id: USER_A_DISABLED }, data: { isActive: false } });

    const second = await upload(MACHINE_A_ACTIVE, "sample-roast.alog");
    expect(second.status).toBe(401);
    expect(await importCount(TENANT_A)).toBe(before);
  });

  it("never lets machineId change the write target tenant", async () => {
    authEnv.store.clear();
    await loginAs({ id: USER_A, tenantId: TENANT_A, email: "manual-a@example.com", name: "Manual A" });
    const beforeB = await importCount(TENANT_B);

    await upload(MACHINE_B, "sweet-marias-real.alog");

    expect(await importCount(TENANT_B)).toBe(beforeB);
    expect(
      await prisma.artisanRoastImport.count({
        where: { machineId: MACHINE_B },
      }),
    ).toBe(0);
  });

  it("creates no roast or import when ownership fails", async () => {
    authEnv.store.clear();
    await loginAs({ id: USER_A, tenantId: TENANT_A, email: "manual-a@example.com", name: "Manual A" });
    const beforeImports = await importCount(TENANT_A);
    const beforeRoasts = await prisma.roast.count({ where: { tenantId: TENANT_A } });

    await upload(MACHINE_B, "sweet-marias-real.alog");
    await upload("machine-never-exists", "sweet-marias-real.alog");
    await upload(MACHINE_A_INACTIVE, "sweet-marias-real.alog");

    expect(await importCount(TENANT_A)).toBe(beforeImports);
    expect(await prisma.roast.count({ where: { tenantId: TENANT_A } })).toBe(beforeRoasts);
    expect(
      await prisma.artisanRoastImport.count({ where: { machineId: MACHINE_B } }),
    ).toBe(0);
  });

  it("fallback without machineId only uses the caller's active machine", async () => {
    authEnv.store.clear();
    await loginAs({ id: USER_A, tenantId: TENANT_A, email: "manual-a@example.com", name: "Manual A" });
    const before = await importCount(TENANT_A);

    const res = await upload(null, "sweet-marias-real.alog");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const importRow = await prisma.artisanRoastImport.findFirst({
      where: { tenantId: TENANT_A },
      orderBy: { uploadedAt: "desc" },
    });
    expect(importRow).not.toBeNull();
    expect(importRow?.machineId).toBe(MACHINE_A_ACTIVE);
    expect(importRow?.tenantId).toBe(TENANT_A);
    expect(importRow?.connectorId).toBeNull();
    expect(await importCount(TENANT_A)).toBe(before + 1);
  });

  it("keeps connector imports bound to their real connector", async () => {
    const importRow = await prisma.artisanRoastImport.create({
      data: {
        tenantId: TENANT_A,
        machineId: MACHINE_A_ACTIVE,
        connectorId: CONNECTOR_A,
        originalFilename: "connector-a.alog",
        fileHash: "hash-connector-a",
        fileSize: 10,
        storageKey: `artisan/${TENANT_A}/connector-a.alog`,
        status: "UPLOADED",
      },
    });

    const withConnector = await prisma.artisanRoastImport.findUnique({
      where: { id: importRow.id },
      include: { connector: true },
    });
    expect(withConnector?.connector).not.toBeNull();
    expect(withConnector?.connector?.id).toBe(CONNECTOR_A);
    expect(withConnector?.connector?.tenantId).toBe(TENANT_A);
  });

  it("never creates a global hidden connector and preserves isolation", async () => {
    authEnv.store.clear();
    await loginAs({ id: USER_A, tenantId: TENANT_A, email: "manual-a@example.com", name: "Manual A" });

    await upload(MACHINE_A_ACTIVE, "sweet-marias-real.alog");

    // No hidden "manual-upload" row anywhere.
    expect(await prisma.roastdStudio.count({ where: { id: "manual-upload" } })).toBe(0);

    // Manual imports carry no connector, so they cannot reach another
    // tenant's connector; connector imports resolve within their own tenant.
    const manualRow = await prisma.artisanRoastImport.findFirst({
      where: { tenantId: TENANT_A, connectorId: null },
      include: { connector: true },
    });
    expect(manualRow).not.toBeNull();
    const connectorRows = await prisma.artisanRoastImport.findMany({
      where: { tenantId: TENANT_A, connectorId: { not: null } },
      include: { connector: { select: { tenantId: true } } },
    });
    expect(connectorRows.every((row) => row.connector?.tenantId === TENANT_A)).toBe(true);
  });

  it("leaves no orphaned connector foreign keys", async () => {
    const rows = await prisma.$queryRaw<Array<{ c: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS c
      FROM "artisan_roast_imports" i
      LEFT JOIN "roastd_studios" c ON c.id = i."connectorId"
      WHERE i."tenantId" IN (${TENANT_A}, ${TENANT_B})
        AND i."connectorId" IS NOT NULL
        AND c.id IS NULL
    `);
    expect(rows[0]?.c).toBe(0);
  });
});
