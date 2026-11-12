'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Button, Field, FormError, Input } from '@/components/ui';
import { api } from '@/lib/api';

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get('next');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/login', { email, password });
      // Only follow same-site relative paths to avoid open redirects.
      router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm text-ink-2">Use your OPSILUME account.</p>
      </div>
      <FormError error={error} />
      <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
      <Field label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
      <Button type="submit" variant="primary" loading={busy} className="w-full">
        Sign in
      </Button>
      <p className="text-center text-[13px] text-ink-2">
        New here?{' '}
        <Link href="/register" className="font-medium text-accent hover:underline">
          Create an organisation
        </Link>
      </p>
      {process.env.NODE_ENV !== 'production' && (
        <div className="rounded-md border border-line bg-sunken px-3 py-2 text-[12px] text-ink-2">
          Demo data (after <code className="font-mono">npm run db:seed</code>): <span className="font-mono text-ink">demo@example.com</span> / <span className="font-mono text-ink">OPSILUME-demo-1</span>
        </div>
      )}
    </form>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
