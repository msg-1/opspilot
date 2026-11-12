import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-sm text-ink-2">This address does not exist, or the item was removed.</p>
      <Link href="/" className="mt-2 inline-flex h-9 items-center rounded-md bg-ink px-3.5 text-sm font-medium text-white hover:bg-black">Go to overview</Link>
    </div>
  );
}
