"use client";

import { useRouter } from "next/navigation";

/** Chooses whom the onboarding simulation walks through: a new company, or an existing client. */
export function OnboardingPreviewPicker({
  clients,
  selectedClientId,
}: {
  clients: { id: string; name: string }[];
  selectedClientId: string | null;
}) {
  const router = useRouter();
  return (
    <div className="mb-6 flex items-center justify-end gap-2 text-xs text-muted-2">
      <label htmlFor="ob-sim-client">Simulate as</label>
      <select
        id="ob-sim-client"
        value={selectedClientId ?? ""}
        onChange={(e) =>
          router.push(
            e.target.value
              ? `/admin/onboarding-preview?clientId=${encodeURIComponent(e.target.value)}`
              : "/admin/onboarding-preview",
          )
        }
        className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground"
      >
        <option value="">New company</option>
        {[...clients]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
      </select>
    </div>
  );
}
