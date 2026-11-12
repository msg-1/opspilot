export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <div className="relative hidden flex-col justify-between overflow-hidden bg-rail p-10 text-rail-ink lg:flex">
        <div className="flex items-center gap-2.5">
          <span aria-hidden className="flex size-8 items-center justify-center rounded-lg bg-white text-rail">
            <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 13h4l2.5-7 4 13 2.5-6H21" />
            </svg>
          </span>
          <span className="text-lg font-semibold tracking-tight text-white">OpsPilot</span>
        </div>
        <div>
          <p className="max-w-md text-[28px] leading-tight font-semibold tracking-tight text-white">From alert to evidence-backed hypothesis, with a human on every production change.</p>
          <ul className="mt-6 space-y-2.5 text-sm">
            <li>Correlates logs, deployments, code changes and metrics around an incident</li>
            <li>Every claim in an investigation cites the record it came from</li>
            <li>Remediation runs only after explicit approval, and is fully audited</li>
          </ul>
        </div>
        <p className="text-[12px] text-rail-ink/60">Runs entirely on your machine. No data leaves it unless you configure an AI provider.</p>
      </div>
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}
