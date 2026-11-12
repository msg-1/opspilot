'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { ServiceRef } from '@/lib/types';
import { Button, Field, FormError, Input, Modal, Select, Textarea } from './ui';

export const REMEDIATION_TYPES: [string, string][] = [
  ['rollback_deployment', 'Roll back a deployment'],
  ['restart_service', 'Restart a service'],
  ['scale_service', 'Scale a service'],
  ['toggle_feature_flag', 'Toggle a feature flag'],
  ['config_change', 'Change configuration'],
  ['run_runbook', 'Run a runbook'],
  ['manual', 'Other manual action'],
];

export function ProposeRemediation({ open, onClose, incidentId, services }: { open: boolean; onClose: () => void; incidentId?: string; services: ServiceRef[] }) {
  const router = useRouter();
  const { run, busy, error } = useAction();
  const [form, setForm] = useState({ type: 'rollback_deployment', title: '', description: '', rationale: '', risk: 'MEDIUM', serviceId: '' });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Propose a remediation action"
      wide
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="propose" loading={!!busy}>Create proposal</Button></>}
    >
      <form
        id="propose"
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const created = await run(() => api.post<{ id: string }>('/remediations', { ...form, rationale: form.rationale || null, serviceId: form.serviceId || null, incidentId: incidentId ?? null }));
          if (created) router.push(`/remediation/${created.id}`);
        }}
      >
        <p className="text-[13px] text-ink-2">A proposal changes nothing by itself. It must be submitted for approval, approved by someone else, and then executed by a person.</p>
        <FormError error={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Action type">{(id) => <Select id={id} value={form.type} onChange={set('type')}>{REMEDIATION_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}</Field>
          <Field label="Risk" hint="High-risk actions need two approvals, one from an admin.">
            {(id) => <Select id={id} value={form.risk} onChange={set('risk')}><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option></Select>}
          </Field>
        </div>
        <Field label="Title">{(id) => <Input id={id} required minLength={4} maxLength={200} placeholder="Roll back checkout-service to v2.13.2" value={form.title} onChange={set('title')} />}</Field>
        <Field label="Service">{(id) => <Select id={id} value={form.serviceId} onChange={set('serviceId')}><option value="">Not specific to one service</option>{services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
        <Field label="What exactly will be done?">{(id) => <Textarea id={id} required minLength={4} rows={3} value={form.description} onChange={set('description')} />}</Field>
        <Field label="Why?" hint="The evidence or reasoning an approver needs.">{(id) => <Textarea id={id} rows={2} value={form.rationale} onChange={set('rationale')} />}</Field>
      </form>
    </Modal>
  );
}
