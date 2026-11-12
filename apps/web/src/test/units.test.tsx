import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfidenceMeter, EngineBadge, HealthBadge, RemediationStatusBadge, SeverityBadge } from '@/components/badges';
import { EngineNotice } from '@/components/engine-notice';
import { ErrorState, FormError, Pagination, Tabs } from '@/components/ui';
import { ApiError, api, qs, useApi } from '@/lib/api';
import { compact, duration, timeAgo, titleCase } from '@/lib/format';

const json = (status: number, body: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('formatting', () => {
  it('formats durations, counts and relative times', () => {
    expect([duration(0.4), duration(45), duration(95), duration(120), duration(60 * 24 * 3), duration(null)]).toEqual(['<1m', '45m', '1h 35m', '2h', '3d', '—']);
    expect([compact(950), compact(1500), compact(12_400), compact(2_500_000), compact(0.173), compact(null)]).toEqual(['950', '1.5k', '12k', '2.5M', '0.17', '—']);
    const now = Date.parse('2026-01-10T12:00:00Z');
    expect([timeAgo('2026-01-10T11:59:40Z', now), timeAgo('2026-01-10T11:30:00Z', now), timeAgo('2026-01-10T07:00:00Z', now), timeAgo('2026-01-07T12:00:00Z', now), timeAgo(null, now)]).toEqual(['just now', '30m ago', '5h ago', '3d ago', '—']);
    expect(titleCase('PENDING_APPROVAL')).toBe('Pending approval');
    expect(qs({ a: 'x y', b: '', c: undefined, d: 2 })).toBe('?a=x+y&d=2');
  });
});

describe('API client', () => {
  it('turns API error envelopes into ApiError with field details', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(400, { error: { code: 'validation_error', message: 'Request validation failed', details: [{ path: 'title', message: 'Too short' }] } }));
    const error = await api.post('/incidents', { title: 'x' }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: 'validation_error', details: [{ path: 'title', message: 'Too short' }] });
  });

  it('refreshes the session once on 401 and retries the original request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(401, { error: { code: 'unauthorized', message: 'Authentication required' } })).mockResolvedValueOnce(json(200, { accessToken: 't' })).mockResolvedValueOnce(json(200, { data: [1] }));
    await expect(api.get('/incidents')).resolves.toEqual({ data: [1] });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/v1/incidents', '/api/v1/auth/refresh', '/api/v1/incidents']);
  });

  it('reports an unreachable API in plain language', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    await expect(api.get('/dashboard')).rejects.toMatchObject({ status: 0, message: expect.stringContaining('Cannot reach the OpsPilot API') });
  });

  it('useApi shows data, and does not retry client errors', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(403, { error: { code: 'forbidden', message: 'You do not have permission to do this' } }));
    function Probe() {
      const { error, isLoading } = useApi<unknown>('/audit-logs', { retry: (count, e) => !(e instanceof ApiError && e.status < 500) && count < 2 });
      return isLoading ? <p>loading</p> : <ErrorState error={error} />;
    }
    render(<QueryClientProvider client={new QueryClient()}><Probe /></QueryClientProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have access to this');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('components', () => {
  it('never conveys status by colour alone', () => {
    render(<><SeverityBadge severity="SEV1" /><HealthBadge health="DEGRADED" /><HealthBadge health="UNKNOWN" /><RemediationStatusBadge status="PENDING_APPROVAL" /></>);
    for (const label of ['SEV1 · Critical', 'Degraded', 'No data', 'Awaiting approval']) expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('exposes confidence as an accessible meter', () => {
    render(<ConfidenceMeter value={0.62} status="possible" />);
    expect(screen.getByRole('meter', { name: 'Confidence' })).toHaveAttribute('aria-valuenow', '62');
    expect(screen.getByText('Possible')).toBeInTheDocument();
  });

  it('is explicit about which engine analyses an investigation', () => {
    const limits = { maxOutputTokensPerCall: 8000, requestTimeoutSeconds: 120, maxRetries: 2, maxCostUsdPerInvestigation: 0.5, maxTokensPerInvestigation: 400000 };
    const { rerender } = render(<EngineNotice status={{ reachable: true, llm: { provider: 'heuristic', configuredProvider: 'none', model: null, available: false, detail: 'Set ANTHROPIC_API_KEY.' } }} />);
    expect(screen.getByText(/No AI model is in use/)).toBeInTheDocument();
    rerender(<EngineNotice status={{ reachable: true, llm: { provider: 'heuristic', configuredProvider: 'anthropic', model: null, available: false, detail: 'ANTHROPIC_API_KEY is not set.' } }} />);
    expect(screen.getByText(/is configured but not usable/)).toBeInTheDocument();
    rerender(<EngineNotice status={{ reachable: true, llm: { provider: 'anthropic', model: 'claude-haiku-5-5', available: true, detail: '', limits }, usageToday: { investigations: 2, running: 0, estimatedCostUsd: 0.0031, tokens: 9000 }, organizationLimits: { maxConcurrent: 3, dailyInvestigations: 50, dailyCostUsd: 5 } }} />);
    expect(screen.getByText('claude-haiku-5-5')).toBeInTheDocument();
    expect(screen.getByText(/uses paid API credit/)).toBeInTheDocument();
    expect(screen.getByText(/\$0.50 per investigation, \$5.00 per day. Today: 2 investigations, estimated \$0.0031/)).toBeInTheDocument();
    rerender(<EngineNotice status={{ reachable: true, llm: { provider: 'mock', model: 'mock-scripted', available: true, detail: '' } }} />);
    expect(screen.getByText(/Mock AI is active/)).toBeInTheDocument();
    rerender(<EngineNotice status={{ reachable: false, detail: 'connection refused' }} />);
    expect(screen.getByText(/AI service is not reachable/)).toBeInTheDocument();
  });

  it('never presents mock or rule-based output as model output', () => {
    const { rerender } = render(<EngineBadge mode="llm" provider="anthropic" model="claude-haiku-5-5" attemptedProvider="anthropic" />);
    expect(screen.getByText(/Claude · claude-haiku-5-5/)).toBeInTheDocument();
    rerender(<EngineBadge mode="mock" provider="mock" model="mock-scripted" />);
    expect(screen.getByText(/Mock AI · no model was called/)).toBeInTheDocument();
    rerender(<EngineBadge mode="heuristic" provider="heuristic" model={null} attemptedProvider={null} />);
    expect(screen.getByText(/Rule-based engine · no AI model/)).toBeInTheDocument();
    rerender(<EngineBadge mode="heuristic" provider="heuristic" model={null} attemptedProvider="anthropic" />);
    expect(screen.getByText(/Rule-based engine · Claude was unavailable/)).toBeInTheDocument();
  });

  it('renders validation details in form errors', () => {
    render(<FormError error={new ApiError(400, 'validation_error', 'Request validation failed', [{ path: 'password', message: 'Password must be at least 10 characters' }])} />);
    expect(screen.getByRole('alert')).toHaveTextContent('password: Password must be at least 10 characters');
  });

  it('tabs and pagination are keyboard-operable controls', async () => {
    const onTab = vi.fn();
    const onPage = vi.fn();
    render(<><Tabs value="a" onChange={onTab} tabs={[{ id: 'a', label: 'Active', count: 3 }, { id: 'b', label: 'Resolved' }]} /><Pagination page={1} totalPages={3} total={55} onPage={onPage} /></>);
    expect(screen.getByRole('tab', { name: /Active/ })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('tab', { name: 'Resolved' }));
    expect(onTab).toHaveBeenCalledWith('b');
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(onPage).toHaveBeenCalledWith(2));
  });
});
