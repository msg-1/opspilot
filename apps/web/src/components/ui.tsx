'use client';

import clsx from 'clsx';
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react';
import Link from 'next/link';
import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, useEffect, useId, useRef } from 'react';
import { ApiError } from '@/lib/api';

// ───────────────────────── Buttons ─────────────────────────

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANT: Record<Variant, string> = {
  primary: 'bg-ink text-white hover:bg-black disabled:bg-ink-3',
  secondary: 'bg-surface text-ink border border-line-strong hover:bg-sunken disabled:text-ink-3',
  ghost: 'text-ink-2 hover:bg-sunken hover:text-ink disabled:text-ink-3',
  danger: 'bg-critical text-white hover:bg-critical-ink disabled:opacity-60',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', loading, icon, children, className, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed',
        size === 'sm' ? 'h-7 px-2.5 text-[13px]' : 'h-9 px-3.5 text-sm',
        VARIANT[variant],
        className,
      )}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function LinkButton({ href, variant = 'secondary', size = 'md', icon, children, className }: { href: string; variant?: Variant; size?: 'sm' | 'md'; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Link href={href} className={clsx('inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors', size === 'sm' ? 'h-7 px-2.5 text-[13px]' : 'h-9 px-3.5 text-sm', VARIANT[variant], className)}>
      {icon}
      {children}
    </Link>
  );
}

// ───────────────────────── Layout ─────────────────────────

export function PageHeader({ title, description, actions, back }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <header className="mb-6">
      {back && (
        <Link href={back.href} className="mb-2 inline-flex items-center gap-1 text-[13px] text-ink-2 hover:text-ink">
          <ChevronLeft className="size-3.5" aria-hidden />
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[22px] leading-tight font-semibold tracking-tight text-ink">{title}</h1>
          {description && <p className="mt-1 max-w-3xl text-sm text-ink-2">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function Card({ title, description, actions, children, className, padded = true }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={clsx('rounded-card border border-line bg-surface shadow-card', className)}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            {description && <p className="mt-0.5 text-[13px] text-ink-2">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={padded ? 'p-4' : undefined}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'critical' | 'warn' | 'good' }) {
  return (
    <div className="rounded-card border border-line bg-surface px-4 py-3 shadow-card">
      <div className="text-[12px] font-medium text-ink-2">{label}</div>
      <div className={clsx('tabular mt-1 text-[26px] leading-none font-semibold tracking-tight', tone === 'critical' ? 'text-critical-ink' : tone === 'warn' ? 'text-warn-ink' : tone === 'good' ? 'text-good-ink' : 'text-ink')}>{value}</div>
      {hint && <div className="mt-1.5 text-[12px] text-ink-3">{hint}</div>}
    </div>
  );
}

// ───────────────────────── Feedback states ─────────────────────────

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-ink-2">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}…
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={clsx('animate-pulse rounded-md bg-sunken', className)} />;
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong';
  const forbidden = error instanceof ApiError && error.status === 403;
  return (
    <div role="alert" className="flex flex-col items-center gap-2 rounded-card border border-critical/30 bg-critical-soft px-4 py-8 text-center">
      <AlertTriangle className="size-5 text-critical-ink" aria-hidden />
      <p className="text-sm font-medium text-critical-ink">{forbidden ? 'You do not have access to this' : 'This could not be loaded'}</p>
      <p className="max-w-md text-[13px] text-ink-2">{message}</p>
      {retry && !forbidden && (
        <Button size="sm" onClick={retry} className="mt-1">
          Try again
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
      {icon && <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-sunken text-ink-2">{icon}</div>}
      <p className="text-sm font-semibold text-ink">{title}</p>
      {description && <p className="max-w-md text-[13px] text-ink-2">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  const details = error instanceof ApiError ? error.details : undefined;
  return (
    <div role="alert" className="rounded-md border border-critical/30 bg-critical-soft px-3 py-2 text-[13px] text-critical-ink">
      {error instanceof Error ? error.message : String(error)}
      {details && details.length > 0 && (
        <ul className="mt-1 list-disc pl-4">
          {details.map((d) => (
            <li key={d.path + d.message}>
              {d.path ? <span className="font-medium">{d.path}: </span> : null}
              {d.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'good'; children: ReactNode }) {
  return (
    <div className={clsx('rounded-md border px-3 py-2 text-[13px]', tone === 'warn' ? 'border-warn/50 bg-warn-soft text-warn-ink' : tone === 'good' ? 'border-good/30 bg-good-soft text-good-ink' : 'border-accent/20 bg-accent-soft text-accent-strong')}>
      {children}
    </div>
  );
}

// ───────────────────────── Form controls ─────────────────────────

const CONTROL = 'rounded-md border border-line-strong bg-surface px-2.5 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-2 focus:outline-accent/30 disabled:bg-sunken';

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: (id: string) => ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-[13px] font-medium text-ink">
        {label}
      </label>
      {children(id)}
      {hint && <p className="mt-1 text-[12px] text-ink-3">{hint}</p>}
    </div>
  );
}

/** Controls fill their container unless the caller sets an explicit width (w-48, flex-1, …). */
const width = (className?: string) => (className && /(^|\s)(w-|flex-1)/.test(className) ? undefined : 'w-full');

export const Input = (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} className={clsx(CONTROL, 'h-9', width(props.className), props.className)} />;
export const Textarea = (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} className={clsx(CONTROL, 'w-full py-2 leading-relaxed', props.className)} />;
export const Select = (props: SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} className={clsx(CONTROL, 'h-9 max-w-full pr-7', width(props.className), props.className)} />;

// ───────────────────────── Overlays ─────────────────────────

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-label={title}
      className={clsx('m-auto w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface p-0 text-ink shadow-pop backdrop:bg-ink/40', wide ? 'max-w-2xl' : 'max-w-lg')}
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-ink-2 hover:bg-sunken">
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
      {footer && <div className="flex justify-end gap-2 border-t border-line bg-sunken/50 px-5 py-3">{footer}</div>}
    </dialog>
  );
}

// ───────────────────────── Data display ─────────────────────────

export function Table({ head, children, className }: { head: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('overflow-x-auto', className)}>
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-line text-[12px] font-medium text-ink-2 [&>th]:px-4 [&>th]:py-2.5 [&>th]:font-medium">{head}</tr>
        </thead>
        <tbody className="[&>tr]:border-b [&>tr]:border-line [&>tr:last-child]:border-0 [&>tr>td]:px-4 [&>tr>td]:py-2.5 [&>tr>td]:align-middle">{children}</tbody>
      </table>
    </div>
  );
}

export function Pagination({ page, totalPages, total, onPage }: { page: number; totalPages: number; total: number; onPage: (p: number) => void }) {
  if (totalPages <= 1) return <div className="px-4 py-2.5 text-[12px] text-ink-3">{total} result{total === 1 ? '' : 's'}</div>;
  return (
    <div className="flex items-center justify-between px-4 py-2.5 text-[13px] text-ink-2">
      <span>
        Page {page} of {totalPages} · {total} results
      </span>
      <div className="flex gap-1">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)} icon={<ChevronLeft className="size-3.5" aria-hidden />}>
          Previous
        </Button>
        <Button size="sm" variant="ghost" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
          Next
          <ChevronRight className="size-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={clsx('-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap', value === t.id ? 'border-ink text-ink' : 'border-transparent text-ink-2 hover:text-ink')}
        >
          {t.label}
          {t.count !== undefined && <span className="tabular ml-1.5 rounded-full bg-sunken px-1.5 py-0.5 text-[11px] text-ink-2">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return (
    <span aria-hidden className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white" style={{ width: size, height: size, fontSize: size * 0.4, background: `oklch(0.5 0.09 ${hue})` }}>
      {name
        .split(/\s+/)
        .slice(0, 2)
        .map((p) => p[0]?.toUpperCase())
        .join('')}
    </span>
  );
}

export const Mono = ({ children, className }: { children: ReactNode; className?: string }) => <span className={clsx('font-mono text-[12.5px]', className)}>{children}</span>;

export function DefinitionList({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-2.5 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-2">{k}</dt>
          <dd className="min-w-0 text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
