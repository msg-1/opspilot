'use client';

import Link from 'next/link';
import { useEffect } from 'react';

/** Catches render errors anywhere in the app so a failure shows a way forward, not a blank page. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-xl font-semibold tracking-tight">Something went wrong on this page</h1>
      <p className="text-sm text-ink-2">The rest of OPSILUME is unaffected. You can try again, or go back to the overview.</p>
      {error.digest && <p className="font-mono text-[12px] text-ink-3">Reference: {error.digest}</p>}
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={reset} className="h-9 rounded-md bg-ink px-3.5 text-sm font-medium text-white hover:bg-black">Try again</button>
        <Link href="/" className="inline-flex h-9 items-center rounded-md border border-line-strong bg-surface px-3.5 text-sm font-medium hover:bg-sunken">Go to overview</Link>
      </div>
    </div>
  );
}
