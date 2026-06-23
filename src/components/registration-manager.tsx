"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Button, Input, Label, Select, Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { approveRegistrationAction, rejectRegistrationAction } from "@/lib/actions";
import { initials, relativeTime } from "@/lib/utils";
import type { AppUser, Client, Role } from "@/lib/types";

const NEW_CLIENT = "__new__";

interface RowForm {
  role: Role;
  /** Existing client id, or NEW_CLIENT to create one. */
  clientTarget: string;
  newClientName: string;
  assigned: string[];
}

export function RegistrationManager({ pending, clients }: { pending: AppUser[]; clients: Client[] }) {
  const router = useRouter();
  const [forms, setForms] = useState<Record<string, RowForm>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The default approval state for a user: pre-fill the role/company they requested at signup.
  function baseForm(u: AppUser): RowForm {
    const role: Role = u.requestedRole ?? "employee";
    return {
      role,
      // Clients default to creating a new client seeded with the name they typed at signup.
      clientTarget: role === "client" ? NEW_CLIENT : clients[0]?.id ?? NEW_CLIENT,
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
    if (f.role === "client") {
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
        clientId: f.role === "client" && f.clientTarget !== NEW_CLIENT ? f.clientTarget : undefined,
        newClientName: f.role === "client" && f.clientTarget === NEW_CLIENT ? f.newClientName : undefined,
        assignedClientIds: f.role === "employee" ? f.assigned : undefined,
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
                    Requested: {u.requestedRole === "client" ? "Client" : "Agency staff"}
                  </Badge>
                )}
              </div>
            </div>

            {u.requestedRole === "client" && u.requestedClientName && (
              <p className="text-xs text-muted">
                Said they're from <span className="text-foreground">{u.requestedClientName}</span>.
              </p>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Approve as</Label>
                <Select value={f.role} onChange={(e) => update(u, { role: e.target.value as Role })}>
                  <option value="employee">Employee</option>
                  <option value="client">Client</option>
                  <option value="admin">Admin</option>
                </Select>
              </div>

              {f.role === "client" && (
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

            {f.role === "client" && f.clientTarget === NEW_CLIENT && (
              <div>
                <Label>New client name</Label>
                <Input
                  value={f.newClientName}
                  onChange={(e) => update(u, { newClientName: e.target.value })}
                  placeholder="Acme Co"
                />
              </div>
            )}

            {f.role === "employee" && clients.length > 0 && (
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
