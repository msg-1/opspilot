'use client';

import { Copy, Plus, Trash2, UserPlus, Users } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/badges';
import { Avatar, Button, Card, EmptyState, ErrorState, Field, FormError, Input, Modal, Notice, PageHeader, Select, Spinner, Table, Tabs, Textarea } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { timeAgo, titleCase } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { Member } from '@/lib/types';

interface Team { id: string; name: string; description: string | null; members: { userId: string; isLead: boolean; onCall: boolean; user: { id: string; name: string; title: string | null } }[]; services: { id: string; name: string }[] }
interface Invitation { id: string; email: string; role: string; expiresAt: string }
const ROLES = ['OWNER', 'ADMIN', 'ENGINEER', 'VIEWER'];
const ROLE_HELP: Record<string, string> = { OWNER: 'Everything, including organisation settings', ADMIN: 'Manage members, integrations, API keys; approve high-risk actions', ENGINEER: 'Run investigations, manage incidents, approve low and medium risk actions', VIEWER: 'Read-only' };
const RANK: Record<string, number> = { VIEWER: 0, ENGINEER: 1, ADMIN: 2, OWNER: 3 };

function InviteDialog({ onClose, myRole }: { onClose: () => void; myRole: string }) {
  const { run, busy, error } = useAction();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('ENGINEER');
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  return (
    <Modal open onClose={onClose} title="Invite a teammate" footer={link ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="invite" loading={!!busy}>Create invitation</Button></>}>
      {link ? (
        <div className="space-y-3">
          <Notice tone="good">Invitation created for <strong>{email}</strong>. It is valid for 7 days.</Notice>
          <p className="text-[13px] text-ink-2">No email provider is configured in this local installation, so send them this link yourself. It is shown only once.</p>
          <div className="flex gap-2"><Input readOnly aria-label="Invitation link" value={link} className="font-mono text-[12px]" onFocus={(e) => e.target.select()} /><Button icon={<Copy className="size-3.5" aria-hidden />} onClick={() => { void navigator.clipboard.writeText(link); setCopied(true); }}>{copied ? 'Copied' : 'Copy'}</Button></div>
        </div>
      ) : (
        <form id="invite" className="space-y-4" onSubmit={async (e) => { e.preventDefault(); const r = await run(() => api.post<{ acceptPath: string }>('/members/invitations', { email, role })); if (r) setLink(`${window.location.origin}${r.acceptPath}`); }}>
          <FormError error={error} />
          <Field label="Email">{(id) => <Input id={id} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Field label="Role" hint={ROLE_HELP[role]}>{(id) => <Select id={id} value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.filter((r) => RANK[r]! <= RANK[myRole]!).map((r) => <option key={r} value={r}>{titleCase(r)}</option>)}</Select>}</Field>
        </form>
      )}
    </Modal>
  );
}

function TeamDialog({ onClose }: { onClose: () => void }) {
  const { run, busy, error } = useAction();
  const [f, setF] = useState({ name: '', description: '' });
  return (
    <Modal open onClose={onClose} title="New team" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="team" loading={!!busy}>Create team</Button></>}>
      <form id="team" className="space-y-4" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post('/teams', { name: f.name, description: f.description || null }))) onClose(); }}>
        <FormError error={error} />
        <Field label="Name">{(id) => <Input id={id} required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="What it owns">{(id) => <Textarea id={id} rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
      </form>
    </Modal>
  );
}

export default function TeamPage() {
  const session = useSession();
  const [tab, setTab] = useState<'members' | 'teams'>('members');
  const [dialog, setDialog] = useState<null | 'invite' | 'team'>(null);
  const { run, error: actionError } = useAction();
  const members = useApi<{ data: Member[]; invitations: Invitation[] }>('/members');
  const teams = useApi<{ data: Team[] }>('/teams');
  const canManageMembers = session.can('member:manage');
  const canManageTeams = session.can('team:manage');
  const myRank = RANK[session.role]!;

  return (
    <>
      <PageHeader
        title="Team"
        description="Who has access to this organisation, what they can do, and which team owns what."
        actions={tab === 'members' ? canManageMembers && <Button variant="primary" icon={<UserPlus className="size-4" aria-hidden />} onClick={() => setDialog('invite')}>Invite</Button> : canManageTeams && <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setDialog('team')}>New team</Button>}
      />
      <FormError error={actionError} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'members', label: 'Members', count: members.data?.data.length }, { id: 'teams', label: 'Teams', count: teams.data?.data.length }]} />

      {tab === 'members' && (members.error ? <ErrorState error={members.error} /> : members.isLoading || !members.data ? <Spinner /> : (
        <div className="space-y-4">
          <Card padded={false}>
            <Table head={<><th>Person</th><th>Role</th><th>Teams</th><th>Last active</th><th /></>}>
              {members.data.data.map((m) => {
                const editable = canManageMembers && RANK[m.role]! <= myRank && m.user.id !== session.user.id;
                return (
                  <tr key={m.id}>
                    <td><div className="flex items-center gap-2.5"><Avatar name={m.user.name} size={30} /><div><div className="font-medium">{m.user.name}{m.user.id === session.user.id && <span className="ml-1.5 text-[12px] font-normal text-ink-3">you</span>}</div><div className="text-[12px] text-ink-2">{m.user.email}{m.user.title ? ` · ${m.user.title}` : ''}</div></div></div></td>
                    <td>{editable ? <Select aria-label={`Role of ${m.user.name}`} className="h-8 w-32" value={m.role} onChange={(e) => void run(() => api.patch(`/members/${m.id}`, { role: e.target.value }))}>{ROLES.filter((r) => RANK[r]! <= myRank).map((r) => <option key={r} value={r}>{titleCase(r)}</option>)}</Select> : <Badge tone={m.role === 'OWNER' ? 'info' : 'neutral'}>{titleCase(m.role)}</Badge>}</td>
                    <td><div className="flex flex-wrap gap-1">{m.teams.map((t) => <Badge key={t.id} tone={t.onCall ? 'good' : 'neutral'}>{t.name}{t.onCall ? ' · on call' : t.isLead ? ' · lead' : ''}</Badge>)}{!m.teams.length && <span className="text-ink-3">—</span>}</div></td>
                    <td className="whitespace-nowrap text-ink-2">{m.user.lastLoginAt ? timeAgo(m.user.lastLoginAt) : 'Never signed in'}</td>
                    <td className="text-right">{editable && <Button size="sm" variant="ghost" aria-label={`Remove ${m.user.name}`} onClick={() => { if (window.confirm(`Remove ${m.user.name} from ${session.organization.name}? They lose access immediately.`)) void run(() => api.delete(`/members/${m.id}`)); }}><Trash2 className="size-3.5" aria-hidden /></Button>}</td>
                  </tr>
                );
              })}
            </Table>
          </Card>
          {members.data.invitations.length > 0 && (
            <Card title="Pending invitations" padded={false}>
              <Table head={<><th>Email</th><th>Role</th><th>Expires</th><th /></>}>
                {members.data.invitations.map((i) => (
                  <tr key={i.id}><td>{i.email}</td><td><Badge>{titleCase(i.role)}</Badge></td><td className="text-ink-2">{timeAgo(i.expiresAt)}</td><td className="text-right">{canManageMembers && <Button size="sm" variant="ghost" onClick={() => void run(() => api.delete(`/members/invitations/${i.id}`))}>Revoke</Button>}</td></tr>
                ))}
              </Table>
            </Card>
          )}
        </div>
      ))}

      {tab === 'teams' && (teams.isLoading || !teams.data ? <Spinner /> : teams.data.data.length === 0 ? (
        <Card><EmptyState icon={<Users className="size-5" aria-hidden />} title="No teams yet" description="Teams own services and carry the on-call rotation shown on each service." action={canManageTeams ? <Button size="sm" onClick={() => setDialog('team')}>Create a team</Button> : undefined} /></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {teams.data.data.map((t) => {
            const available = members.data?.data.filter((m) => !t.members.some((x) => x.userId === m.user.id)) ?? [];
            return (
              <Card key={t.id} title={t.name} description={t.description ?? undefined} actions={canManageTeams && <Button size="sm" variant="ghost" aria-label={`Delete team ${t.name}`} onClick={() => { if (window.confirm(`Delete the team "${t.name}"? Its services become unowned.`)) void run(() => api.delete(`/teams/${t.id}`)); }}><Trash2 className="size-3.5" aria-hidden /></Button>}>
                <ul className="space-y-2">
                  {t.members.map((m) => (
                    <li key={m.userId} className="flex items-center gap-2 text-sm">
                      <Avatar name={m.user.name} size={22} /><span className="min-w-0 flex-1 truncate">{m.user.name}</span>
                      {m.isLead && <Badge>Lead</Badge>}
                      {canManageTeams ? <button type="button" aria-pressed={m.onCall} onClick={() => void run(() => api.put(`/teams/${t.id}/members/${m.userId}`, { onCall: !m.onCall }))} className={`rounded-full border px-2 py-0.5 text-[12px] font-medium ${m.onCall ? 'border-good/30 bg-good-soft text-good-ink' : 'border-line text-ink-3 hover:text-ink'}`}>{m.onCall ? 'On call' : 'Off call'}</button> : m.onCall && <Badge tone="good">On call</Badge>}
                      {canManageTeams && <button type="button" aria-label={`Remove ${m.user.name} from ${t.name}`} onClick={() => void run(() => api.delete(`/teams/${t.id}/members/${m.userId}`))} className="text-ink-3 hover:text-critical-ink"><Trash2 className="size-3.5" aria-hidden /></button>}
                    </li>
                  ))}
                  {!t.members.length && <li className="text-[13px] text-ink-3">No members</li>}
                </ul>
                {canManageTeams && available.length > 0 && (
                  <Select aria-label={`Add a member to ${t.name}`} className="mt-3 h-8" value="" onChange={(e) => e.target.value && void run(() => api.put(`/teams/${t.id}/members/${e.target.value}`, {}))}>
                    <option value="">Add member…</option>{available.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.name}</option>)}
                  </Select>
                )}
                <div className="mt-4 border-t border-line pt-3 text-[12px] text-ink-2">{t.services.length ? `Owns ${t.services.map((s) => s.name).join(', ')}` : 'Owns no services'}</div>
              </Card>
            );
          })}
        </div>
      ))}
      {dialog === 'invite' && <InviteDialog onClose={() => setDialog(null)} myRole={session.role} />}
      {dialog === 'team' && <TeamDialog onClose={() => setDialog(null)} />}
    </>
  );
}
