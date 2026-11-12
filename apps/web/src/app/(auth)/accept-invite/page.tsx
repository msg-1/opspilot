'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Button, ErrorState, Field, FormError, Input, Spinner } from '@/components/ui';
import { api, useApi } from '@/lib/api';

function AcceptForm() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const invite = useApi<{ email: string; role: string; organizationName: string; hasAccount: boolean }>(token ? `/auth/invitations/${encodeURIComponent(token)}` : null, { retry: false });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (!token) return <ErrorState error={new Error('This invitation link is incomplete.')} />;
  if (invite.isLoading) return <Spinner />;
  if (invite.error || !invite.data) return <ErrorState error={invite.error} />;
  const { email, role, organizationName, hasAccount } = invite.data;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/accept-invitation', { token, password, ...(hasAccount ? {} : { name }) });
      router.replace('/');
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Join {organizationName}</h1>
        <p className="mt-1 text-sm text-ink-2">
          You were invited as <span className="font-medium text-ink">{email}</span> with the {role.toLowerCase()} role.
        </p>
      </div>
      <FormError error={error} />
      {!hasAccount && <Field label="Your name">{(id) => <Input id={id} required value={name} onChange={(e) => setName(e.target.value)} />}</Field>}
      <Field label={hasAccount ? 'Your existing OPSILUME password' : 'Choose a password'} hint={hasAccount ? undefined : 'At least 10 characters, with a letter and a number.'}>
        {(id) => <Input id={id} type="password" required minLength={hasAccount ? 1 : 10} autoComplete={hasAccount ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} />}
      </Field>
      <Button type="submit" variant="primary" loading={busy} className="w-full">
        Accept invitation
      </Button>
    </form>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense>
      <AcceptForm />
    </Suspense>
  );
}
