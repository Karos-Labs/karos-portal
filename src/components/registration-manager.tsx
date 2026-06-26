"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Button, Input, Label, Select, Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import {
  approveRegistrationAction,
  rejectRegistrationAction,
  reviewClientRequestAction,
} from "@/lib/actions";
import { initials, relativeTime } from "@/lib/utils";
import type { AppUser, Client, ClientRequest, Role } from "@/lib/types";

const NEW_CLIENT = "__new__";

interface RowForm {
  role: Role;
  clientTarget: string;
  newClientName: string;
  assigned: string[];
}

/* ─────────────────── Pending self-signup registrations ─────────────────── */

export function RegistrationManager({
  pending,
  clients,
}: {
  pending: AppUser[];
  clients: Client[];
}) {
  const router = useRouter();
  const [forms, setForms] = useState<Record<string, RowForm>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function baseForm(u: AppUser): RowForm {
    const role: Role = u.requestedRole ?? "KAROS_EMPLOYEE";
    return {
      role,
      clientTarget: role === "CLIENT_USER" ? NEW_CLIENT : clients[0]?.id ?? NEW_CLIENT,
      newClientName: u.requestedClientName ?? "",
      assigned: [],
    };
  }

  function formFor(u: AppUser): RowForm {
    return forms[u.uid] ?? baseForm(u);
  }

  function update(u: AppUser, patch: Partial<RowForm>) {
    setForms((s) => ({ ...s, [u.uid]: { ...(s[u.uid] ?? baseForm(u)), ...patch } }));
  }

  async function approve(u: AppUser) {
    const f = formFor(u);
    setError(null);
    if (f.role === "CLIENT_USER") {
      if (f.clientTarget === NEW_CLIENT && !f.newClientName.trim()) {
        return setError("Enter a name for the new client.");
      }
      if (f.clientTarget !== NEW_CLIENT && !f.clientTarget) {
        return setError("Pick a client or create a new one.");
      }
    }
    setBusy(u.uid);
    try {
      await approveRegistrationAction(u.uid, {
        role: f.role,
        clientId: f.role === "CLIENT_USER" && f.clientTarget !== NEW_CLIENT ? f.clientTarget : undefined,
        newClientName: f.role === "CLIENT_USER" && f.clientTarget === NEW_CLIENT ? f.newClientName : undefined,
        assignedClientIds: f.role === "KAROS_EMPLOYEE" ? f.assigned : undefined,
      });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not approve");
    } finally {
      setBusy(null);
    }
  }

  async function reject(u: AppUser) {
    setError(null);
    setBusy(u.uid);
    try {
      await rejectRegistrationAction(u.uid);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reject");
    } finally {
      setBusy(null);
    }
  }

  if (pending.length === 0) {
    return (
      <EmptyState
        icon={<Icon name="UserCheck" className="h-7 w-7" />}
        title="No pending registrations"
        description="New sign-ups awaiting approval will show up here."
      />
    );
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-xs text-danger">{error}</p>}
      {pending.map((u) => {
        const f = formFor(u);
        return (
          <Card key={u.uid} className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold text-neon">
                  {initials(u.name)}
                </div>
                <div>
                  <p className="text-sm font-medium">{u.name}</p>
                  <p className="text-xs text-muted-2">{u.email} · {relativeTime(u.createdAt)}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone="warning">Pending</Badge>
                {u.requestedRole && (
                  <Badge tone="neutral">
                    Requested: {u.requestedRole === "CLIENT_USER" ? "Client" : "Agency staff"}
                  </Badge>
                )}
              </div>
            </div>

            {u.requestedRole === "CLIENT_USER" && u.requestedClientName && (
              <p className="text-xs text-muted">
                Said they&apos;re from <span className="text-foreground">{u.requestedClientName}</span>.
              </p>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Approve as</Label>
                <Select value={f.role} onChange={(e) => update(u, { role: e.target.value as Role })}>
                  <option value="KAROS_EMPLOYEE">Employee</option>
                  <option value="CLIENT_USER">Client</option>
                  <option value="KAROS_ADMIN">Admin</option>
                </Select>
              </div>

              {f.role === "CLIENT_USER" && (
                <div>
                  <Label>Client account</Label>
                  <Select value={f.clientTarget} onChange={(e) => update(u, { clientTarget: e.target.value })}>
                    <option value={NEW_CLIENT}>+ Create new client</option>
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </Select>
                </div>
              )}
            </div>

            {f.role === "CLIENT_USER" && f.clientTarget === NEW_CLIENT && (
              <div>
                <Label>New client name</Label>
                <Input
                  value={f.newClientName}
                  onChange={(e) => update(u, { newClientName: e.target.value })}
                  placeholder="Acme Co"
                />
              </div>
            )}

            {f.role === "KAROS_EMPLOYEE" && clients.length > 0 && (
              <div>
                <Label>Assign clients</Label>
                <div className="flex flex-wrap gap-1.5">
                  {clients.map((c) => {
                    const on = f.assigned.includes(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() =>
                          update(u, {
                            assigned: on ? f.assigned.filter((x) => x !== c.id) : [...f.assigned, c.id],
                          })
                        }
                        className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                          on ? "border-neon/40 bg-neon-soft text-neon" : "border-border text-muted"
                        }`}
                      >
                        {c.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
              <Button size="sm" variant="danger" disabled={busy === u.uid} onClick={() => reject(u)}>
                Reject
              </Button>
              <Button size="sm" loading={busy === u.uid} onClick={() => approve(u)}>
                <Icon name="Check" className="h-4 w-4" />
                Approve
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

/* ─────────────────── Client access request reviews ─────────────────── */

export function ClientRequestManager({ requests }: { requests: ClientRequest[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  async function review(id: string, status: "APPROVED" | "REJECTED") {
    setError(null);
    setBusy(id);
    try {
      await reviewClientRequestAction(id, status, notes[id]);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update request");
    } finally {
      setBusy(null);
    }
  }

  if (requests.length === 0) {
    return (
      <EmptyState
        icon={<Icon name="Building2" className="h-7 w-7" />}
        title="No pending access requests"
        description="Prospective clients who submitted the request form will show up here."
      />
    );
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-xs text-danger">{error}</p>}
      {requests.map((r) => (
        <Card key={r.id} className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-neon-soft text-neon">
                <Icon name="Building2" className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-medium">{r.companyName}</p>
                <p className="text-xs text-muted-2">
                  {r.adminEmail}
                  {r.website && <> · <a href={r.website} target="_blank" rel="noopener" className="text-neon hover:underline">{r.website}</a></>}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone="warning">Pending</Badge>
              <span className="text-xs text-muted-2">{relativeTime(r.submittedAt)}</span>
            </div>
          </div>

          <div className="rounded-[10px] bg-surface-2 px-4 py-3">
            <p className="text-xs font-medium text-muted mb-1">Use case</p>
            <p className="text-sm">{r.useCase}</p>
          </div>

          <div>
            <Label>Review notes (optional)</Label>
            <Input
              value={notes[r.id] ?? ""}
              onChange={(e) => setNotes((s) => ({ ...s, [r.id]: e.target.value }))}
              placeholder="e.g. Approved — create client and send key"
            />
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
            <Button
              size="sm"
              variant="danger"
              disabled={busy === r.id}
              loading={busy === r.id}
              onClick={() => review(r.id, "REJECTED")}
            >
              Reject
            </Button>
            <Button
              size="sm"
              disabled={busy === r.id}
              loading={busy === r.id}
              onClick={() => review(r.id, "APPROVED")}
            >
              <Icon name="Check" className="h-4 w-4" />
              Approve
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}
