import { ArrowRight, Check, Coffee, Monitor, ShieldCheck } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hashStudioVerificationCode } from "@/lib/artisan/connector-auth";
import { approveStudioDevice } from "./actions";

export default async function StudioAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; error?: string }>;
}) {
  const { code = "", error } = await searchParams;
  if (code.length < 24 || code.length > 128) {
    return <AuthorizationMessage title="Tautan tidak valid" description="Mulai login kembali dari Roastd Studio." />;
  }

  const user = await requireRole("OWNER");

  const [authorization, machines, tenant] = await Promise.all([
    prisma.studioDeviceAuthorization.findUnique({
      where: { verificationCodeHash: hashStudioVerificationCode(code) },
      select: { status: true, expiresAt: true, computerName: true, platform: true },
    }),
    prisma.machine.findMany({
      where: { tenantId: user.tenantId, isActive: true },
      select: { id: true, name: true, capacityKg: true },
      orderBy: { name: "asc" },
    }),
    prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { name: true } }),
  ]);

  if (!authorization || authorization.status !== "PENDING" || authorization.expiresAt <= new Date()) {
    return <AuthorizationMessage title="Permintaan sudah berakhir" description="Kembali ke Roastd Studio dan tekan Masuk dengan Roastd sekali lagi." />;
  }

  return (
    <main className="instrument-grid-dark min-h-dvh bg-[#0b0f10] p-4 text-[#f2e7d5] sm:p-8">
      <div className="mx-auto grid min-h-[calc(100dvh-4rem)] max-w-5xl overflow-hidden rounded-[22px] border border-white/10 bg-[#111617] shadow-2xl lg:grid-cols-[.72fr_1.28fr]">
        <aside className="relative flex flex-col justify-between overflow-hidden border-b border-white/10 bg-[#0e1314] p-7 lg:border-b-0 lg:border-r lg:p-10">
          <div>
            <div className="mb-12 flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-xl border border-[#f07a42]/40 bg-[#f07a42]/10"><Coffee size={19} className="text-[#f07a42]" /></span>
              <div><p className="font-bold">Roastd Studio</p><p className="text-xs uppercase tracking-[.18em] text-[#809091]">Device login</p></div>
            </div>
            <p className="mb-3 text-xs font-bold uppercase tracking-[.18em] text-[#5ad4dc]">Sambungkan komputer roasting</p>
            <h1 className="max-w-sm text-3xl font-semibold leading-tight tracking-[-.04em] sm:text-4xl">Pilih mesin. Studio mengurus sisanya.</h1>
          </div>
          <div className="mt-12 space-y-4 text-sm text-[#94a2a3]">
            <p className="flex gap-3"><ShieldCheck size={17} className="mt-0.5 shrink-0 text-[#5dd39e]" /> Password dan sesi akun tidak disimpan di desktop.</p>
            <p className="flex gap-3"><Check size={17} className="mt-0.5 shrink-0 text-[#5dd39e]" /> Izin hanya berlaku untuk satu workspace dan satu mesin.</p>
          </div>
        </aside>

        <section className="flex flex-col justify-center p-7 sm:p-10 lg:p-14">
          <div className="mb-8 flex items-center gap-3 rounded-xl border border-[#2d4645] bg-[#122020] px-4 py-3">
            <Monitor size={18} className="text-[#5ad4dc]" />
            <div><p className="text-xs font-bold">{authorization.computerName}</p><p className="text-xs text-[#809091]">{authorization.platform} · meminta akses ke {tenant?.name ?? "workspace"}</p></div>
          </div>

          <h2 className="text-xl font-semibold">Hubungkan ke mesin</h2>
          <p className="mt-2 text-sm leading-6 text-[#809091]">Roast dan telemetry dari komputer ini akan masuk ke mesin yang dipilih.</p>

          {error ? <p className="mt-5 rounded-lg border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">{error}</p> : null}
          {machines.length === 0 ? (
            <p className="mt-6 rounded-xl border border-dashed border-white/15 p-5 text-sm text-[#aab5b5]">Belum ada mesin aktif. Tambahkan mesin dari Master Data terlebih dahulu.</p>
          ) : (
            <form action={approveStudioDevice} className="mt-7 space-y-5">
              <input type="hidden" name="code" value={code} />
              <label className="block">
                <span className="mb-2 block text-xs font-bold uppercase tracking-[.14em] text-[#809091]">Mesin roasting</span>
                <select name="machineId" required defaultValue="" className="h-12 w-full rounded-[10px] border border-white/15 bg-[#0b0f10] px-4 text-sm text-[#f2e7d5] outline-none focus:border-[#5ad4dc] focus:ring-2 focus:ring-[#5ad4dc]/20">
                  <option value="" disabled>Pilih mesin…</option>
                  {machines.map((machine) => <option key={machine.id} value={machine.id}>{machine.name}{machine.capacityKg ? " · " + machine.capacityKg.toString() + " kg" : ""}</option>)}
                </select>
              </label>
              <button className="flex h-12 w-full items-center justify-center gap-2 rounded-[10px] bg-[#f07a42] font-bold text-[#1b0e08] transition hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-[#5ad4dc]">
                Izinkan dan hubungkan <ArrowRight size={17} />
              </button>
            </form>
          )}
          <p className="mt-6 text-center text-xs leading-5 text-[#667475]">Izin kedaluwarsa otomatis dalam 10 menit dan hanya dapat digunakan sekali.</p>
        </section>
      </div>
    </main>
  );
}

function AuthorizationMessage({ title, description }: { title: string; description: string }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-[#0b0f10] p-5 text-[#f2e7d5]">
      <section className="max-w-md rounded-2xl border border-white/10 bg-[#111617] p-8 text-center shadow-2xl">
        <Monitor className="mx-auto mb-5 text-[#f07a42]" />
        <h1 className="text-xl font-bold">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-[#809091]">{description}</p>
      </section>
    </main>
  );
}
