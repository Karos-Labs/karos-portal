"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/modal";
import { Button, Label, Input, Select } from "@/components/ui";
import { addCompetitorAction } from "@/lib/actions";
import type { ClientCompetitor } from "@/lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
  clientId: string;
}

const TIER_OPTIONS: ClientCompetitor["marketTier"][] = ["Leader", "Challenger", "Niche", "Other"];
const OVERLAP_OPTIONS: ClientCompetitor["overlap"][] = ["High", "Medium", "Low-Med", "Low"];
const THREAT_OPTIONS: Array<ClientCompetitor["threatLevel"]> = ["HIGH", "MEDIUM", "LOW"];

export function AddCompetitorModal({ open, onClose, clientId }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const empty = {
    company: "",
    url: "",
    founded: "",
    marketTier: "Challenger" as ClientCompetitor["marketTier"],
    minInvestment: "",
    overlap: "Medium" as ClientCompetitor["overlap"],
    positioning: "",
    scale: "",
    keyStrengths: "",
    keyWeaknesses: "",
    threatLevel: undefined as ClientCompetitor["threatLevel"],
  };
  const [form, setForm] = useState(empty);

  function set<K extends keyof typeof empty>(key: K, val: (typeof empty)[K]) {
    setForm((s) => ({ ...s, [key]: val }));
  }

  async function submit() {
    if (!form.company.trim()) {
      setError("Company name is required.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await addCompetitorAction(clientId, {
        company: form.company.trim(),
        url: form.url.trim() || undefined,
        founded: form.founded.trim() || undefined,
        marketTier: form.marketTier,
        minInvestment: form.minInvestment.trim() || undefined,
        overlap: form.overlap,
        positioning: form.positioning.trim() || undefined,
        scale: form.scale.trim() || undefined,
        keyStrengths: form.keyStrengths
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        keyWeaknesses: form.keyWeaknesses
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        threatLevel: form.threatLevel,
      });
      setForm(empty);
      onClose();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save competitor");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add Competitor"
      description="Manually add a competitor to the tracker."
      className="max-w-lg"
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Company name *</Label>
            <Input
              value={form.company}
              onChange={(e) => set("company", e.target.value)}
              placeholder="ACME Corp"
            />
          </div>
          <div>
            <Label>Website</Label>
            <Input
              value={form.url}
              onChange={(e) => set("url", e.target.value)}
              placeholder="acme.com"
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label>Market tier</Label>
            <Select
              value={form.marketTier}
              onChange={(e) => set("marketTier", e.target.value as ClientCompetitor["marketTier"])}
            >
              {TIER_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Overlap</Label>
            <Select
              value={form.overlap}
              onChange={(e) => set("overlap", e.target.value as ClientCompetitor["overlap"])}
            >
              {OVERLAP_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Threat level</Label>
            <Select
              value={form.threatLevel ?? ""}
              onChange={(e) =>
                set(
                  "threatLevel",
                  (e.target.value as ClientCompetitor["threatLevel"]) || undefined,
                )
              }
            >
              <option value="">—</option>
              {THREAT_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Founded</Label>
            <Input
              value={form.founded}
              onChange={(e) => set("founded", e.target.value)}
              placeholder="2019"
            />
          </div>
          <div>
            <Label>Min. investment</Label>
            <Input
              value={form.minInvestment}
              onChange={(e) => set("minInvestment", e.target.value)}
              placeholder="R$500"
            />
          </div>
        </div>

        <div>
          <Label>Positioning</Label>
          <Input
            value={form.positioning}
            onChange={(e) => set("positioning", e.target.value)}
            placeholder="How they position themselves in the market"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Key strengths (one per line)</Label>
            <textarea
              value={form.keyStrengths}
              onChange={(e) => set("keyStrengths", e.target.value)}
              placeholder={"Mobile app\nZero fees\nCentral Bank licence"}
              className="h-24 w-full rounded-[10px] border border-border bg-surface-2 px-3 py-2 text-sm placeholder:text-muted-2 focus:outline-none focus:ring-1 focus:ring-neon/40 resize-none"
            />
          </div>
          <div>
            <Label>Key weaknesses (one per line)</Label>
            <textarea
              value={form.keyWeaknesses}
              onChange={(e) => set("keyWeaknesses", e.target.value)}
              placeholder={"No secondary market\nPoor support"}
              className="h-24 w-full rounded-[10px] border border-border bg-surface-2 px-3 py-2 text-sm placeholder:text-muted-2 focus:outline-none focus:ring-1 focus:ring-neon/40 resize-none"
            />
          </div>
        </div>

        {error && <p className="text-xs text-danger">{error}</p>}

        <div className="flex gap-2 pt-1">
          <Button className="flex-1" loading={loading} onClick={submit}>
            Add competitor
          </Button>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
