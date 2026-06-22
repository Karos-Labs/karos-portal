"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Button, Input, Label, Select, Badge } from "@/components/ui";
import { Modal } from "@/components/modal";
import { Icon } from "@/components/icon";
import { createTeamMemberAction, updateTeamMemberAction } from "@/lib/actions";
import { initials } from "@/lib/utils";
import type { AppUser, Client, Role } from "@/lib/types";

export function TeamManager({ users, clients, currentUid }: { users: AppUser[]; clients: Client[]; currentUid: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ name: string; email: string; password: string; role: Role; clientId: string; assigned: string[] }>({
    name: "",
    email: "",
    password: "",
    role: "employee",
    clientId: clients[0]?.id ?? "",
    assigned: [],
  });

  const clientName = (id?: string | null) => clients.find((c) => c.id === id)?.name ?? "—";

  async function create() {
    setError(null);
    if (!form.name.trim() || !form.email.trim() || form.password.length < 6) {
      return setError("Name, email and a 6+ char password are required.");
    }
    setLoading(true);
    try {
      await createTeamMemberAction({
        name: form.name,
        email: form.email,
        password: form.password,
        role: form.role,
        clientId: form.role === "client" ? form.clientId : undefined,
        assignedClientIds: form.role === "employee" ? form.assigned : undefined,
      });
      setOpen(false);
      setForm({ name: "", email: "", password: "", role: "employee", clientId: clients[0]?.id ?? "", assigned: [] });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create user");
    } finally {
      setLoading(false);
    }
  }

  async function setRole(uid: string, role: Role) {
    await updateTeamMemberAction(uid, { role });
    router.refresh();
  }
  async function toggleDisabled(u: AppUser) {
    await updateTeamMemberAction(u.uid, { disabled: !u.disabled });
    router.refresh();
  }

  return (
    <>
      <div className="mb-6 flex justify-end">
        <Button onClick={() => setOpen(true)}>
          <Icon name="UserPlus" className="h-4 w-4" />
          Add member
        </Button>
      </div>

      <Card className="p-0">
        <ul className="divide-y divide-border">
          {users.map((u) => (
            <li key={u.uid} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold text-neon">
                  {initials(u.name)}
                </div>
                <div>
                  <p className="text-sm font-medium">
                    {u.name}
                    {u.uid === currentUid && <span className="ml-2 text-xs text-muted-2">(you)</span>}
                  </p>
                  <p className="text-xs text-muted-2">
                    {u.email}
                    {u.role === "client" && u.clientId && ` · ${clientName(u.clientId)}`}
                    {u.role === "employee" && u.assignedClientIds?.length ? ` · ${u.assignedClientIds.length} clients` : ""}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {u.disabled && <Badge tone="warning">Disabled</Badge>}
                <Select value={u.role} onChange={(e) => setRole(u.uid, e.target.value as Role)} className="h-8 w-32 text-xs" disabled={u.uid === currentUid}>
                  <option value="admin">Admin</option>
                  <option value="employee">Employee</option>
                  <option value="client">Client</option>
                </Select>
                {u.uid !== currentUid && (
                  <Button size="sm" variant={u.disabled ? "outline" : "danger"} onClick={() => toggleDisabled(u)}>
                    {u.disabled ? "Enable" : "Disable"}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title="Add team member" description="Create an employee or client login.">
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))} />
            </div>
            <div>
              <Label>Role</Label>
              <Select value={form.role} onChange={(e) => setForm((s) => ({ ...s, role: e.target.value as Role }))}>
                <option value="employee">Employee</option>
                <option value="client">Client</option>
                <option value="admin">Admin</option>
              </Select>
            </div>
          </div>
          <div>
            <Label>Email</Label>
            <Input type="email" value={form.email} onChange={(e) => setForm((s) => ({ ...s, email: e.target.value }))} />
          </div>
          <div>
            <Label>Temporary password</Label>
            <Input type="text" value={form.password} onChange={(e) => setForm((s) => ({ ...s, password: e.target.value }))} placeholder="6+ characters" />
          </div>

          {form.role === "client" && (
            <div>
              <Label>Belongs to client</Label>
              <Select value={form.clientId} onChange={(e) => setForm((s) => ({ ...s, clientId: e.target.value }))}>
                {clients.length === 0 && <option value="">Create a client first</option>}
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
            </div>
          )}

          {form.role === "employee" && clients.length > 0 && (
            <div>
              <Label>Assign clients</Label>
              <div className="flex flex-wrap gap-1.5">
                {clients.map((c) => {
                  const on = form.assigned.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setForm((s) => ({ ...s, assigned: on ? s.assigned.filter((x) => x !== c.id) : [...s.assigned, c.id] }))}
                      className={`rounded-full border px-3 py-1 text-xs transition-colors ${on ? "border-neon/40 bg-neon-soft text-neon" : "border-border text-muted"}`}
                    >
                      {c.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {error && <p className="text-xs text-danger">{error}</p>}
          <Button className="w-full" loading={loading} onClick={create}>Create login</Button>
        </div>
      </Modal>
    </>
  );
}
