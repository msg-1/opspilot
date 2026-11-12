'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Field, FormError, Input } from '@/components/ui';
import { api } from '@/lib/api';

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({ organizationName: '', name: '', email: '', password: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/register', form);
      router.replace('/');
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Create your organisation</h1>
        <p className="mt-1 text-sm text-ink-2">You become its owner and can invite your team afterwards.</p>
      </div>
      <FormError error={error} />
      <Field label="Organisation name">{(id) => <Input id={id} required minLength={2} value={form.organizationName} onChange={set('organizationName')} />}</Field>
      <Field label="Your name">{(id) => <Input id={id} required autoComplete="name" value={form.name} onChange={set('name')} />}</Field>
      <Field label="Work email">{(id) => <Input id={id} type="email" required autoComplete="email" value={form.email} onChange={set('email')} />}</Field>
      <Field label="Password" hint="At least 10 characters, with a letter and a number.">
        {(id) => <Input id={id} type="password" required minLength={10} autoComplete="new-password" value={form.password} onChange={set('password')} />}
      </Field>
      <Button type="submit" variant="primary" loading={busy} className="w-full">
        Create organisation
      </Button>
      <p className="text-center text-[13px] text-ink-2">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
