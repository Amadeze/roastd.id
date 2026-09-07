"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { saveCommerceSettings } from "../actions";

export function CommerceSettingsClientForm({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      try {
        const result = await saveCommerceSettings(formData);
        if (result && !result.success) {
          toast.error(result.error || "Gagal menyimpan pengaturan.");
        } else if (result && result.success) {
          toast.success("Pengaturan berhasil disimpan.");
          // Force the server component to re-render with the persisted values
          // so uncontrolled inputs (defaultValue) reflect the saved state.
          router.refresh();
        }
      } catch (err: any) {
        toast.error(err.message || "Terjadi kesalahan saat menyimpan pengaturan.");
      }
    });
  }

  return (
    <form action={handleSubmit} className="mx-auto grid max-w-4xl gap-5 p-4 md:p-6 lg:p-8">
      {children}
    </form>
  );
}
