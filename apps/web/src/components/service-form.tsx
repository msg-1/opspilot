'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, useApi } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { Service } from '@/lib/types';
import { Button, Field, FormError, Input, Modal, Select, Textarea } from './ui';

export function ServiceForm({ open, onClose, service }: { open: boolean; onClose: () => void; service?: Service }) {
  const router = useRouter();
  const teams = useApi<{ data: { id: string; name: string }[] }>(open ? '/teams' : null);
  const { run, busy, error } = useAction();
  const [form, setForm] = useState({ name: service?.name ?? '', description: service?.description ?? '', tier: service?.tier ?? 'TIER2', language: service?.language ?? '', repoUrl: service?.repoUrl ?? '', ownerTeamId: service?.ownerTeamId ?? '' });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Modal open={open} onClose={onClose} title={service ? `Edit ${service.name}` : 'Add a service'} wide footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="service-form" loading={!!busy}>{service ? 'Save changes' : 'Add service'}</Button></>}>
      <form
        id="service-form"
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const body = { ...form, description: form.description || null, language: form.language || null, repoUrl: form.repoUrl || null, ownerTeamId: form.ownerTeamId || null };
          const saved = await run(() => (service ? api.patch<Service>(`/services/${service.id}`, body) : api.post<Service>('/services', body)));
          if (saved) {
            onClose();
            if (!service) router.push(`/services/${saved.id}`);
          }
        }}
      >
        <FormError error={error} />
        <Field label="Name">{(id) => <Input id={id} required minLength={2} maxLength={80} value={form.name} onChange={set('name')} placeholder="Checkout Service" />}</Field>
        <Field label="Description">{(id) => <Textarea id={id} rows={2} value={form.description} onChange={set('description')} placeholder="What it does and what it owns" />}</Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Tier">{(id) => <Select id={id} value={form.tier} onChange={set('tier')}><option value="TIER1">Tier 1 · critical</option><option value="TIER2">Tier 2 · important</option><option value="TIER3">Tier 3 · supporting</option></Select>}</Field>
          <Field label="Owner team">{(id) => <Select id={id} value={form.ownerTeamId} onChange={set('ownerTeamId')}><option value="">No owner</option>{teams.data?.data.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>}</Field>
          <Field label="Language">{(id) => <Input id={id} value={form.language} onChange={set('language')} placeholder="TypeScript" />}</Field>
        </div>
        <Field label="Repository URL">{(id) => <Input id={id} type="url" value={form.repoUrl} onChange={set('repoUrl')} placeholder="https://github.com/acme/checkout" />}</Field>
      </form>
    </Modal>
  );
}

