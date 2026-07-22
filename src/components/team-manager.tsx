"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, Button, Input, Label, Select, Badge } from "@/components/ui";
import { Modal } from "@/components/modal";
import { Icon } from "@/components/icon";

function ClientKeyCopy({ clientKeyId }: { clientKeyId: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(clientKeyId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <button
      onClick={copy}
      title={copied ? "Copied!" : "Copy client invite key"}
      className="mt-1 flex items-center gap-1.5 rounded-[6px] bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-muted-2 transition-colors hover:text-neon"
    >
      <code className="truncate max-w-[220px]">{clientKeyId}</code>
      <Icon name={copied ? "Check" : "Copy"} className="h-3 w-3 shrink-0" />
    </button>
  );
}
import {
  createTeamMemberAction,
  updateTeamMemberAction,
  toggleGroupAdminAction,
  startImpersonationAction,
} from "@/lib/actions";
import { initials } from "@/lib/utils";
import type { AppUser, Client, Role } from "@/lib/types";

interface Props {
  users: AppUser[];
  clients: Client[];
  currentUid: string;
  currentUserRole: Role;
  currentClientId?: string;
}

function UserRow({
  u,
  clients,
  currentUid,
  currentUserRole,
  onRefresh,
}: {
  u: AppUser;
  clients: Client[];
  currentUid: string;
  currentUserRole: Role;
  onRefresh: () => void;
}) {
  const [actionPending, startAction] = useTransition();
  const [impersonatePending, startImpersonate] = useTransition();
  const clientName = (id?: string | null) => clients.find((c) => c.id === id)?.name ?? "-";
  const isSelf = u.uid === currentUid;
  const isAdmin = currentUserRole === "KAROS_ADMIN";
  const isGroupAdmin = currentUserRole === "CLIENT_USER";

  function act(fn: () => Promise<void>) {
    startAction(async () => {
      await fn();
      onRefresh();
    });
  }

  function impersonate() {
    startImpersonate(async () => {
      await startImpersonationAction(u.uid);
      onRefresh();
    });
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold text-neon">
          {initials(u.name)}
        </div>
        <div>
          <p className="text-sm font-medium">
            {u.name}
            {isSelf && <span className="ml-2 text-xs text-muted-2">(you)</span>}
            {u.isGroupAdmin && (
              <span className="ml-2 rounded-full bg-neon-soft px-2 py-0.5 text-[10px] font-semibold text-neon">
                Group admin
              </span>
            )}
          </p>
          <p className="text-xs text-muted-2">
            {u.email}
            {u.role === "CLIENT_USER" && u.clientId && ` · ${clientName(u.clientId)}`}
            {u.role === "KAROS_EMPLOYEE" && u.assignedClientIds?.length
              ? ` · ${u.assignedClientIds.length} client${u.assignedClientIds.length === 1 ? "" : "s"}`
              : ""}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {u.disabled && <Badge tone="warning">Disabled</Badge>}

        {/* Group admin toggle — admin can toggle any client; group admin can toggle others in their group */}
        {u.role === "CLIENT_USER" && !isSelf && (isAdmin || isGroupAdmin) && (
          <button
            onClick={() => act(() => toggleGroupAdminAction(u.uid, !u.isGroupAdmin))}
            disabled={actionPending}
            title={u.isGroupAdmin ? "Remove group admin" : "Make group admin"}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted transition-colors hover:border-neon/40 hover:text-neon disabled:opacity-50"
          >
            <Icon name="ShieldCheck" className="h-3.5 w-3.5" />
            {u.isGroupAdmin ? "Group admin" : "Make admin"}
          </button>
        )}

        {/* Admin-only controls */}
        {isAdmin && (
          <>
            <Select
              value={u.role}
              onChange={(e) => act(() => updateTeamMemberAction(u.uid, { role: e.target.value as Role }))}
              className="h-8 w-32 text-xs"
              disabled={isSelf || actionPending}
            >
              <option value="KAROS_ADMIN">Admin</option>
              <option value="KAROS_EMPLOYEE">Employee</option>
              <option value="CLIENT_USER">Client</option>
            </Select>

            {!isSelf && (
              <Button
                size="sm"
                variant={u.disabled ? "outline" : "danger"}
                onClick={() => act(() => updateTeamMemberAction(u.uid, { disabled: !u.disabled }))}
                disabled={actionPending}
              >
                {u.disabled ? "Enable" : "Disable"}
              </Button>
            )}

            {u.role === "CLIENT_USER" && !u.disabled && (
              <Button
                size="sm"
                variant="outline"
                onClick={impersonate}
                disabled={impersonatePending}
              >
                <Icon name="Eye" className="h-3.5 w-3.5" />
                {impersonatePending ? "Loading..." : "View as"}
              </Button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function SectionCard({
  title,
  subtitle,
  clientKeyId,
  users,
  clients,
  currentUid,
  currentUserRole,
  onRefresh,
}: {
  title: string;
  subtitle?: string;
  clientKeyId?: string;
  users: AppUser[];
  clients: Client[];
  currentUid: string;
  currentUserRole: Role;
  onRefresh: () => void;
}) {
  if (users.length === 0) return null;
  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {subtitle && <p className="text-xs text-muted-2">{subtitle}</p>}
        {clientKeyId && <ClientKeyCopy clientKeyId={clientKeyId} />}
      </div>
      <Card className="p-0">
        <ul className="divide-y divide-border">
          {users.map((u) => (
            <UserRow
              key={u.uid}
              u={u}
              clients={clients}
              currentUid={currentUid}
              currentUserRole={currentUserRole}
              onRefresh={onRefresh}
            />
          ))}
        </ul>
      </Card>
    </div>
  );
}

export function TeamManager({
  users,
  clients,
  currentUid,
  currentUserRole,
  currentClientId,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{
    name: string;
    email: string;
    password: string;
    role: Role;
    clientId: string;
    assigned: string[];
  }>({
    name: "",
    email: "",
    password: "",
    role: "KAROS_EMPLOYEE",
    clientId: clients[0]?.id ?? "",
    assigned: [],
  });

  function refresh() {
    router.refresh();
  }

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
        clientId: form.role === "CLIENT_USER" ? form.clientId : undefined,
        assignedClientIds: form.role === "KAROS_EMPLOYEE" ? form.assigned : undefined,
      });
      setOpen(false);
      setForm({ name: "", email: "", password: "", role: "KAROS_EMPLOYEE", clientId: clients[0]?.id ?? "", assigned: [] });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create user");
    } finally {
      setLoading(false);
    }
  }

  // Admin view: grouped by Staff + per-client sections
  if (currentUserRole === "KAROS_ADMIN") {
    const staff = users.filter((u) => u.role === "KAROS_ADMIN" || u.role === "KAROS_EMPLOYEE");
    const clientGroups = clients
      .map((c) => ({
        client: c,
        users: users.filter((u) => u.role === "CLIENT_USER" && u.clientId === c.id),
      }))
      .filter((g) => g.users.length > 0);
    const unassignedClients = users.filter(
      (u) => u.role === "CLIENT_USER" && !u.clientId,
    );

    return (
      <>
        <div className="mb-6 flex justify-end">
          <Button onClick={() => setOpen(true)}>
            <Icon name="UserPlus" className="h-4 w-4" />
            Add member
          </Button>
        </div>

        <div className="space-y-8">
          <SectionCard
            title="Staff"
            subtitle="Admins and employees"
            users={staff}
            clients={clients}
            currentUid={currentUid}
            currentUserRole={currentUserRole}
            onRefresh={refresh}
          />

          {clientGroups.map(({ client, users: groupUsers }) => (
            <SectionCard
              key={client.id}
              title={client.name}
              subtitle={`${groupUsers.length} user${groupUsers.length === 1 ? "" : "s"}`}
              clientKeyId={client.clientKeyId}
              users={groupUsers}
              clients={clients}
              currentUid={currentUid}
              currentUserRole={currentUserRole}
              onRefresh={refresh}
            />
          ))}

          {unassignedClients.length > 0 && (
            <SectionCard
              title="Unassigned clients"
              subtitle="Client users not yet linked to a client account"
              users={unassignedClients}
              clients={clients}
              currentUid={currentUid}
              currentUserRole={currentUserRole}
              onRefresh={refresh}
            />
          )}
        </div>

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
                  <option value="KAROS_EMPLOYEE">Employee</option>
                  <option value="CLIENT_USER">Client</option>
                  <option value="KAROS_ADMIN">Admin</option>
                </Select>
              </div>
            </div>
            <div>
              <Label>Email</Label>
              <Input type="email" value={form.email} onChange={(e) => setForm((s) => ({ ...s, email: e.target.value }))} />
            </div>
            <div>
              <Label>Temporary password</Label>
              <Input
                type="text"
                value={form.password}
                onChange={(e) => setForm((s) => ({ ...s, password: e.target.value }))}
                placeholder="6+ characters"
              />
            </div>

            {form.role === "CLIENT_USER" && (
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

            {form.role === "KAROS_EMPLOYEE" && clients.length > 0 && (
              <div>
                <Label>Assign clients</Label>
                <div className="flex flex-wrap gap-1.5">
                  {clients.map((c) => {
                    const on = form.assigned.includes(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() =>
                          setForm((s) => ({
                            ...s,
                            assigned: on
                              ? s.assigned.filter((x) => x !== c.id)
                              : [...s.assigned, c.id],
                          }))
                        }
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
            <Button className="w-full" loading={loading} onClick={create}>
              Create login
            </Button>
          </div>
        </Modal>
      </>
    );
  }

  // Group admin view: flat list of their client group
  const myClient = clients.find((c) => c.id === currentClientId);
  return (
    <div className="space-y-4">
      {myClient && (
        <p className="text-sm text-muted-2">
          Managing team for <span className="font-medium text-foreground">{myClient.name}</span>
        </p>
      )}
      <Card className="p-0">
        <ul className="divide-y divide-border">
          {users.map((u) => (
            <UserRow
              key={u.uid}
              u={u}
              clients={clients}
              currentUid={currentUid}
              currentUserRole={currentUserRole}
              onRefresh={refresh}
            />
          ))}
          {users.length === 0 && (
            <li className="px-5 py-8 text-center text-sm text-muted-2">No team members yet.</li>
          )}
        </ul>
      </Card>
    </div>
  );
}
