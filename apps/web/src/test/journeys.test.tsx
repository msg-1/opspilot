import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Integration, IntegrationOverview, RemediationDetail, Session } from '@/lib/types';

// The journeys a person takes through an incident, rendered as the real pages with the real
// components, session, permissions and API client. Only two things are replaced: the router
// (there is no Next.js server here) and the network, which answers with fixtures typed by the
// API's response contracts. Each test asserts what the person sees and what is sent to the API.

const nav = vi.hoisted(() => ({ params: {} as Record<string, string>, search: '', push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useParams: () => nav.params,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push, replace: nav.replace, back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
}));

import IncidentPage from '@/app/(app)/incidents/[id]/page';
import IntegrationsPage from '@/app/(app)/integrations/page';
import InvestigationPage from '@/app/(app)/investigations/[id]/page';
import InvestigationsPage from '@/app/(app)/investigations/page';
import RemediationDetailPage from '@/app/(app)/remediation/[id]/page';
import LoginPage from '@/app/(auth)/login/page';
import { SessionProvider } from '@/lib/session';
import { incident, investigation, investigationList, remediation, session } from './fixtures';

type Route = unknown | ((body: unknown) => unknown);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number, code: string, message: string) => json(status, { error: { code, message } });

/** Answers the page's requests from a table of `METHOD /path`, and records every request. */
function fakeApi(routes: Record<string, Route>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace('/api/v1', '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const route = routes[`${method} ${path}${url.search}`] ?? routes[`${method} ${path}`];
    if (route === undefined) return apiError(404, 'not_found', `The test has no answer for ${method} ${path}`);
    const result = typeof route === 'function' ? (route as (b: unknown) => unknown)(body) : route;
    return result instanceof Response ? result : json(200, result);
  });
  return { calls, writes: () => calls.filter((c) => c.method !== 'GET') };
}

function show(page: ReactElement, as?: Session) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{as ? <SessionProvider session={as}>{page}</SessionProvider> : page}</QueryClientProvider>);
}

beforeEach(() => {
  nav.params = {};
  nav.search = '';
  nav.push.mockClear();
  nav.replace.mockClear();
});

describe('signing in', () => {
  it('sends the credentials and continues to the page the person was heading for', async () => {
    nav.search = 'next=%2Fincidents%2Finc-1';
    const api = fakeApi({ 'POST /auth/login': { ok: true } });
    show(<LoginPage />);
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/incidents/inc-1'));
    expect(api.calls).toEqual([{ method: 'POST', path: '/auth/login', body: { email: 'ada@example.com', password: 'correct horse' } }]);
  });

  it('says why a sign-in was refused, stays on the page and lets the person try again', async () => {
    fakeApi({ 'POST /auth/login': () => apiError(401, 'invalid_credentials', 'Email or password is incorrect') });
    show(<LoginPage />);
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect');
    expect(nav.replace).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('offers the seeded demo account outside production, with the password the seed really sets', () => {
    show(<LoginPage />);
    // The product was renamed; this credential was deliberately not (apps/api/prisma/seed.ts).
    expect(screen.getByText(/Demo data/)).toHaveTextContent('demo@example.com / OpsPilot-demo-1');
  });

  it.each(['//evil.example/phish', 'https://evil.example', 'javascript:alert(1)'])('never follows a redirect that leaves the site (%s)', async (next) => {
    nav.search = `next=${encodeURIComponent(next)}`;
    fakeApi({ 'POST /auth/login': { ok: true } });
    show(<LoginPage />);
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/'));
  });
});

describe('incident details', () => {
  beforeEach(() => {
    nav.params = { id: 'inc-1' };
  });

  it('shows the incident, what happened on it in order, and links to the investigation and the proposed action', async () => {
    fakeApi({ 'GET /incidents/inc-1': incident, 'GET /members': { data: [] } });
    show(<IncidentPage />, session('ENGINEER'));

    expect(await screen.findByRole('heading', { name: /INC-42.*Checkout returns 500 after the v2\.4\.0 deploy/ })).toBeInTheDocument();
    expect(screen.getByText('Customers cannot complete payment.')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Timeline/ })).toHaveTextContent('4');

    const timeline = screen.getAllByRole('list').find((list) => within(list).queryByText('Incident opened'))!;
    const events = within(timeline).getAllByRole('listitem').map((item) => item.textContent);
    expect(events.map((text) => /Incident opened|Error rate is climbing|AI investigation started|Remediation proposed/.exec(text ?? '')?.[0])).toEqual(['Incident opened', 'Error rate is climbing', 'AI investigation started', 'Remediation proposed']);
    expect(within(timeline).getByRole('link', { name: 'View investigation' })).toHaveAttribute('href', '/investigations/inv-1');
    expect(within(timeline).getByRole('link', { name: 'View action' })).toHaveAttribute('href', '/remediation/act-1');

    // The side panels: the investigation's conclusion, and the action with who proposed it.
    expect(screen.getByRole('link', { name: /Errors began two minutes after v2\.4\.0 was deployed/ })).toHaveAttribute('href', '/investigations/inv-1');
    const action = screen.getByRole('link', { name: /Roll back checkout to v2\.3\.1/ });
    expect(action).toHaveAttribute('href', '/remediation/act-1');
    expect(action).toHaveTextContent('Awaiting approval');
    expect(action).toHaveTextContent('Proposed by AI');
  });

  it('is read-only for a viewer: nothing to edit, investigate, comment on or propose', async () => {
    const api = fakeApi({ 'GET /incidents/inc-1': incident });
    show(<IncidentPage />, session('VIEWER'));
    await screen.findByRole('heading', { name: /INC-42/ });

    expect(screen.queryByRole('button', { name: 'Investigate with AI' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Propose action' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Change status' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Add an update' })).not.toBeInTheDocument();
    expect(screen.getByText('Eve Engineer', { selector: 'dd' })).toBeInTheDocument();
    // The member list is only needed for the assignment controls, so it is not even requested.
    expect(api.calls.map((c) => c.path)).toEqual(['/incidents/inc-1']);
  });

  it('says so when the incident cannot be loaded, instead of showing an empty page', async () => {
    fakeApi({ 'GET /incidents/inc-1': () => apiError(404, 'not_found', 'Incident not found') });
    show(<IncidentPage />, session('ENGINEER'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Incident not found');
  });
});

describe('starting an investigation', () => {
  const idle = { llm: { provider: 'heuristic', model: null, available: false }, embeddings: { provider: 'local', model: 'hashed', dimensions: 768 } };

  it('from the investigations page: asks the question and opens the new investigation', async () => {
    const api = fakeApi({
      'GET /investigations': { data: [], meta: { page: 1, pageSize: 15, total: 0, totalPages: 1 } },
      'GET /investigations/ai-status': idle,
      'GET /incidents': { data: [incident], meta: { page: 1, pageSize: 50, total: 1, totalPages: 1 }, statusCounts: {} },
      'POST /investigations': { id: 'inv-new' },
    });
    show(<InvestigationsPage />, session('ENGINEER'));

    const start = await screen.findByRole('button', { name: 'Investigate' });
    expect(start).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: 'Investigation question' }), 'Why 500?');
    expect(start).toBeEnabled();
    await userEvent.type(screen.getByRole('textbox', { name: 'Investigation question' }), ' What changed before checkout failed');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Link to an incident' }), await screen.findByRole('option', { name: /INC-42/ }));
    await userEvent.click(start);

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/investigations/inv-new'));
    expect(api.writes()).toEqual([{ method: 'POST', path: '/investigations', body: { question: 'Why 500? What changed before checkout failed', incidentId: 'inc-1' } }]);
  });

  it('from an incident: proposes a question about that incident and links the investigation to it', async () => {
    nav.params = { id: 'inc-1' };
    const api = fakeApi({ 'GET /incidents/inc-1': incident, 'GET /members': { data: [] }, 'POST /investigations': { id: 'inv-new' } });
    show(<IncidentPage />, session('ENGINEER'));

    await userEvent.click(await screen.findByRole('button', { name: 'Investigate with AI' }));
    const dialog = screen.getByRole('dialog', { name: 'Investigate INC-42' });
    expect(within(dialog).getByRole('textbox')).toHaveValue(`What is the most likely cause of "${incident.title}", and what changed before it started?`);
    await userEvent.click(within(dialog).getByRole('button', { name: /Investigate|Start/ }));

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/investigations/inv-new'));
    expect(api.writes()).toEqual([{ method: 'POST', path: '/investigations', body: { question: expect.stringContaining(incident.title), incidentId: 'inc-1' } }]);
  });

  it('shows the reason when the daily limit refuses it, and does not navigate away', async () => {
    fakeApi({
      'GET /investigations': investigationList,
      'GET /investigations/ai-status': idle,
      'GET /incidents': { data: [], meta: { page: 1, pageSize: 50, total: 0, totalPages: 1 }, statusCounts: {} },
      'POST /investigations': () => apiError(429, 'limit_reached', 'The daily investigation limit (50) has been reached.'),
    });
    show(<InvestigationsPage />, session('ENGINEER'));
    await userEvent.type(await screen.findByRole('textbox', { name: 'Investigation question' }), 'Why is checkout failing?');
    await userEvent.click(screen.getByRole('button', { name: 'Investigate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The daily investigation limit (50) has been reached.');
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('is not offered to someone who may only read, who still sees the history with its engine label', async () => {
    fakeApi({ 'GET /investigations': investigationList, 'GET /investigations/ai-status': idle });
    show(<InvestigationsPage />, session('VIEWER'));
    const row = await screen.findByRole('link', { name: /What changed before checkout began failing/ });
    expect(row).toHaveTextContent('Incident');
    expect(row).toHaveTextContent('3 evidence · 1 hypotheses');
    expect(row).toHaveTextContent('Rule-based engine · no AI model');
    expect(screen.queryByRole('button', { name: 'Investigate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Investigation question' })).not.toBeInTheDocument();
  });
});

describe('viewing an investigation report', () => {
  beforeEach(() => {
    nav.params = { id: 'inv-1' };
  });

  it('shows the verdict, what it rests on, what was not examined, and never presents rule-based output as a model', async () => {
    fakeApi({ 'GET /investigations/inv-1': investigation });
    show(<InvestigationPage />, session('ENGINEER'));

    expect(await screen.findByRole('heading', { name: 'What changed before checkout began failing?' })).toBeInTheDocument();
    expect(screen.getByText('Rule-based engine · no AI model')).toBeInTheDocument();
    expect(screen.getByText(/Produced by rule-based correlation, not a language model/)).toHaveTextContent('These are hypotheses to verify, not a confirmed root cause.');

    const assessment = screen.getByRole('region', { name: 'Assessment' });
    expect(assessment).toHaveTextContent('Incident');
    expect(assessment).toHaveTextContent('86%');
    expect(assessment).toHaveTextContent('A new error pattern appeared');
    expect(within(assessment).getByText('312 new ERROR lines in checkout')).toBeInTheDocument();
    // A weak signal does not support a verdict and is not listed as if it did.
    expect(within(assessment).queryByText('CPU slightly raised')).not.toBeInTheDocument();
    expect(assessment).toHaveTextContent('Not examined');
    expect(assessment).toHaveTextContent('Traces were not examined.');

    // The hypothesis, with what is observed kept apart from what is assumed and what is missing.
    const hypothesis = screen.getByRole('button', { name: /v2\.4\.0 reduced the database connection pool/ });
    expect(hypothesis).toHaveTextContent('62%');
    expect(hypothesis).toHaveTextContent('Likely');
    expect(screen.getByText('Observed facts')).toBeInTheDocument();
    expect(screen.getByText('The pool size changed in this release.')).toBeInTheDocument();
    expect(screen.getByText('Missing evidence: what would confirm or refute it')).toBeInTheDocument();
    expect(screen.getByText('The diff of v2.4.0 was not reviewed.')).toBeInTheDocument();
    expect(screen.getByText('Review the connection pool change in v2.4.0')).toBeInTheDocument();
    expect(screen.getByText('Latency stayed within its usual range.')).toBeInTheDocument();

    // The proposed change is labelled as one, and nothing here can carry it out.
    const action = screen.getByRole('link', { name: /Roll back checkout to v2\.3\.1/ });
    expect(action).toHaveAttribute('href', '/remediation/act-1');
    expect(action).toHaveTextContent('Changes production');
    expect(screen.getByText('Nothing runs without human approval')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve|execute/i })).not.toBeInTheDocument();
  });

  it('marks a figure the evidence does not support where it is read, and counts it in the evidence check', async () => {
    fakeApi({ 'GET /investigations/inv-1': investigation });
    show(<InvestigationPage />, session('ENGINEER'));

    const check = await screen.findByRole('region', { name: 'Evidence check' });
    expect(check).toHaveTextContent('2 of 3 figures and identifiers in this report match the evidence they cite.');
    expect(check).toHaveTextContent('1 could not be matched');

    const unsupported = screen.getByText('The error rate reached 44%.').closest('li')!;
    expect(within(unsupported).getByText('Unsupported figure')).toBeInTheDocument();
    expect(unsupported).toHaveTextContent('44% · not found in the evidence: no cited evidence holds this value');
    const verified = screen.getByText('v2.4.0 was deployed at 08:58.').closest('li')!;
    expect(within(verified).getByText('Figures verified')).toBeInTheDocument();
  });

  it('warns that mock output is not an analysis', async () => {
    fakeApi({ 'GET /investigations/inv-1': { ...investigation, analysisMode: 'mock', provider: 'mock', report: { ...investigation.report!, analysisMode: 'mock' } } });
    show(<InvestigationPage />, session('ENGINEER'));
    expect(await screen.findByText('This is mock output, not an analysis.')).toBeInTheDocument();
    expect(screen.getByText(/Produced by a scripted mock, not a language model/)).toBeInTheDocument();
  });

  it('says when a model was asked for but the rule-based engine had to stand in', async () => {
    fakeApi({ 'GET /investigations/inv-1': { ...investigation, attemptedProvider: 'anthropic' } });
    show(<InvestigationPage />, session('ENGINEER'));
    expect(await screen.findByText('The AI model could not be used for this investigation,')).toBeInTheDocument();
    expect(screen.getByText(/Rule-based engine · .* was unavailable/)).toBeInTheDocument();
  });

  it('while it runs: shows progress, no findings, and lets the person who may run investigations cancel', async () => {
    const running = { ...investigation, status: 'RUNNING', report: null, hypotheses: [], remediations: [], summary: null, confidence: null, outcome: null, completedAt: null, steps: investigation.steps.slice(0, 2), evidence: investigation.evidence.slice(0, 1) };
    const api = fakeApi({ 'GET /investigations/inv-1': running, 'POST /investigations/inv-1/cancel': { ok: true } });
    show(<InvestigationPage />, session('ENGINEER'));

    expect(await screen.findByText('2 steps · 1 evidence item so far')).toBeInTheDocument();
    expect(screen.getByText('Findings appear when the investigation completes')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Assessment' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(api.writes()).toEqual([{ method: 'POST', path: '/investigations/inv-1/cancel', body: {} }]));
  });

  it('keeps the reason and the completed steps when an investigation failed', async () => {
    fakeApi({ 'GET /investigations/inv-1': { ...investigation, status: 'FAILED', error: 'AI service is not reachable.', report: null, hypotheses: [], remediations: [] } });
    show(<InvestigationPage />, session('VIEWER'));
    expect(await screen.findByText('This investigation failed.')).toBeInTheDocument();
    expect(screen.getByText(/AI service is not reachable\./)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Agent steps/ })).toHaveTextContent('3');
  });
});

describe('reviewing evidence', () => {
  beforeEach(() => {
    nav.params = { id: 'inv-1' };
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('follows a citation from a claim to the evidence behind it', async () => {
    fakeApi({ 'GET /investigations/inv-1': investigation });
    show(<InvestigationPage />, session('VIEWER'));

    const fact = (await screen.findByText('The error rate reached 44%.')).closest('li')!;
    const citation = within(fact).getByRole('button', { name: 'E2' });
    expect(citation).toHaveAttribute('title', 'Log pattern: 312× ERROR in checkout: timeout acquiring connection');
    await userEvent.click(citation);

    expect(screen.getByRole('tab', { name: /Evidence timeline/ })).toHaveAttribute('aria-selected', 'true');
    const item = document.getElementById('ev-E2')!;
    expect(item).toHaveTextContent('312× ERROR in checkout: timeout acquiring connection');
    expect(item).toHaveTextContent('First seen 09:00, not present in the previous 24 hours.');
    expect(item).toHaveTextContent('cited in report');
    expect(within(item).getByRole('link', { name: 'Open source' })).toHaveAttribute('href', '/logs?fingerprint=fp-1&from=24h');
    // The selected item is the one highlighted.
    expect(item.querySelector('.border-accent')).not.toBeNull();
    expect(document.getElementById('ev-E1')!.querySelector('.border-accent')).toBeNull();
  });

  it('lists every item in the order things happened, filters by kind, and shows what is not cited as such', async () => {
    fakeApi({ 'GET /investigations/inv-1': { ...investigation, evidence: [...investigation.evidence, { ...investigation.evidence[0]!, id: 'e-4', ref: 'E4', title: 'Deployment of checkout v2.3.1 (succeeded)', occurredAt: '2026-11-09T10:00:00.000Z' }] } });
    show(<InvestigationPage />, session('VIEWER'));
    await userEvent.click(await screen.findByRole('tab', { name: /Evidence timeline/ }));

    const refs = () => [...document.querySelectorAll('[id^="ev-"]')].map((el) => el.id.slice(3));
    // By time of the event, with undated items last; not by the order the tools happened to run in.
    expect(refs()).toEqual(['E4', 'E1', 'E2', 'E3']);
    await userEvent.click(screen.getByRole('button', { name: /Sorted by time of event/ }));
    expect(refs()).toEqual(['E1', 'E2', 'E3', 'E4']);

    expect(document.getElementById('ev-E4')).not.toHaveTextContent('cited in report');
    expect(document.getElementById('ev-E1')).toHaveTextContent('cited in report');

    await userEvent.click(screen.getByRole('button', { name: 'Deployment 2' }));
    expect(refs()).toEqual(['E1', 'E4']);
    expect(screen.getByRole('button', { name: 'Deployment 2' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'All 4' }));
    expect(refs()).toHaveLength(4);
  });

  it('shows what each tool was asked and what it returned, and the guardrail that changed the report', async () => {
    fakeApi({ 'GET /investigations/inv-1': investigation });
    show(<InvestigationPage />, session('VIEWER'));
    await userEvent.click(await screen.findByRole('tab', { name: /Agent steps/ }));

    expect(screen.getByText('Lowered confidence: rule-based analysis is capped')).toBeInTheDocument();
    const step = screen.getByRole('button', { name: /Looked for new error patterns/ });
    expect(step).toHaveTextContent('find_log_anomalies');
    expect(step).toHaveTextContent('48 ms');
    expect(screen.queryByText(/"from_time": "2h"/)).not.toBeInTheDocument();
    await userEvent.click(step);
    expect(screen.getByText(/"from_time": "2h"/)).toBeInTheDocument();
    expect(screen.getByText(/"fingerprint": "fp-1"/)).toBeInTheDocument();
  });
});

describe('approving a remediation', () => {
  const ada = session('ADMIN', { id: 'user-ada', name: 'Ada Admin' });
  const eve = session('ENGINEER', { id: 'user-eve', name: 'Eve Engineer' });
  beforeEach(() => {
    nav.params = { id: 'act-1' };
  });

  it('shows exactly what is being approved, sends the approval bound to that content, and reflects the result', async () => {
    let current: RemediationDetail = remediation;
    const api = fakeApi({
      'GET /remediations/act-1': () => current,
      'POST /remediations/act-1/approve': () => {
        current = { ...remediation, status: 'APPROVED', approvalsGranted: 1, approvals: [{ id: 'ap-1', decision: 'approved', comment: 'Matches the evidence.', createdAt: '2026-11-10T09:30:00.000Z', approver: { id: 'user-ada', name: 'Ada Admin' }, counts: true, supersededAt: null }] };
        return current;
      },
    });
    show(<RemediationDetailPage />, ada);

    expect(await screen.findByRole('heading', { name: 'Roll back checkout to v2.3.1' })).toBeInTheDocument();
    expect(screen.getByText('Redeploy checkout v2.3.1, the last version before the errors began.')).toBeInTheDocument();
    expect(screen.getByText('Changes production')).toBeInTheDocument();
    expect(screen.getByText(/Classified as a change to production/).closest('p')).toHaveTextContent('a rollback changes what is running');
    expect(screen.getByText(/"toVersion": "v2\.3\.1"/)).toBeInTheDocument();
    expect(screen.getByText('Errors began two minutes after v2.4.0 was deployed.', { selector: 'p.whitespace-pre-wrap' })).toBeInTheDocument();
    expect(screen.getByText('OPSILUME AI')).toBeInTheDocument();
    expect(screen.getByText(/0 of 1 required/)).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Approval progress' })).getByText('Awaiting approval')).toHaveAttribute('aria-current', 'step');

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve this action' });
    expect(dialog).toHaveTextContent('You are approving "Roll back checkout to v2.3.1". Your name and time are recorded in the audit trail.');
    await userEvent.type(within(dialog).getByLabelText('Comment (optional)'), 'Matches the evidence.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));

    // The hash of what was on screen goes with the approval, so it cannot count for edited content.
    await waitFor(() => expect(api.writes()).toEqual([{ method: 'POST', path: '/remediations/act-1/approve', body: { comment: 'Matches the evidence.', expectedHash: 'hash-of-what-the-approver-sees' } }]));
    expect(await screen.findByText(/1 of 1 required/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Approval progress' })).getByText('Approved')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('Matches the evidence.')).toBeInTheDocument();
    // Approving does not execute: that is a separate, explicit step.
    expect(screen.getByRole('button', { name: 'Execute' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('does not offer approval to the person who requested it, and says why', async () => {
    fakeApi({ 'GET /remediations/act-1': remediation });
    show(<RemediationDetailPage />, eve);
    expect(await screen.findByText('You proposed or requested this action, so someone else must approve it.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
  });

  it('keeps a high-risk action for an admin or owner, and gives a viewer no decision at all', async () => {
    fakeApi({ 'GET /remediations/act-1': { ...remediation, risk: 'HIGH', requestedBy: { id: 'user-ada', name: 'Ada Admin' } } });
    const first = show(<RemediationDetailPage />, eve);
    expect(await screen.findByText('High-risk actions must be approved by an admin or owner.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    first.unmount();

    show(<RemediationDetailPage />, session('VIEWER', { id: 'user-vic', name: 'Vic Viewer' }));
    expect(await screen.findByText('Your role cannot approve remediation actions.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve|Reject|Execute|Cancel action/ })).not.toBeInTheDocument();
  });

  it('shows the refusal when the action changed after it was displayed, and records nothing as approved', async () => {
    fakeApi({ 'GET /remediations/act-1': remediation, 'POST /remediations/act-1/approve': () => apiError(409, 'conflict', 'This action was changed after you opened it. Review the current version before approving.') });
    show(<RemediationDetailPage />, ada);
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve this action' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('This action was changed after you opened it.');
    expect(screen.getByText(/0 of 1 required/)).toBeInTheDocument();
  });

  it('requires a reason to reject', async () => {
    const api = fakeApi({ 'GET /remediations/act-1': remediation, 'POST /remediations/act-1/reject': { ...remediation, status: 'REJECTED' } });
    show(<RemediationDetailPage />, ada);
    await userEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = screen.getByRole('dialog', { name: 'Reject this action' });
    const confirm = within(dialog).getByRole('button', { name: 'Reject' });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'The pool change is in v2.3.0, not v2.4.0.');
    await userEvent.click(confirm);
    await waitFor(() => expect(api.writes()).toEqual([{ method: 'POST', path: '/remediations/act-1/reject', body: { comment: 'The pool change is in v2.3.0, not v2.4.0.' } }]));
  });

  it('marks an approval that no longer counts because the action was edited afterwards', async () => {
    fakeApi({ 'GET /remediations/act-1': { ...remediation, approvals: [{ id: 'ap-0', decision: 'approved', comment: null, createdAt: '2026-11-10T09:25:00.000Z', approver: { id: 'user-bob', name: 'Bob Owner' }, counts: false, supersededAt: '2026-11-10T09:27:00.000Z' }] } });
    show(<RemediationDetailPage />, ada);
    expect(await screen.findByText('no longer counts: the action was changed afterwards')).toBeInTheDocument();
    expect(screen.getByText(/0 of 1 required/)).toBeInTheDocument();
    // A superseded decision by someone else does not stop this person deciding on the new content.
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });
});

describe('viewing execution outcomes', () => {
  const ada = session('ADMIN');
  const result = (outcome: 'applied' | 'not_applied' | 'unknown', summary: string) => ({ mode: 'webhook', success: outcome === 'applied', outcome, summary, attempt: 1, contentHash: 'hash-of-what-the-approver-sees' });
  beforeEach(() => {
    nav.params = { id: 'act-1' };
  });

  it('an applied change: says so, with the attempt, and offers nothing further to run', async () => {
    fakeApi({ 'GET /remediations/act-1': { ...remediation, status: 'EXECUTED', approvalsGranted: 1, executedBy: { id: 'user-ada', name: 'Ada Admin' }, executedAt: '2026-11-10T09:40:00.000Z', attempts: 1, executionResult: { ...result('applied', 'The webhook accepted the rollback (HTTP 200).'), detail: { status: 200 } } } });
    show(<RemediationDetailPage />, ada);

    expect(await screen.findByText('The webhook accepted the rollback (HTTP 200).')).toBeInTheDocument();
    expect(screen.getByText('Outcome').nextElementSibling).toHaveTextContent('Applied');
    expect(screen.getByText('Attempt').nextElementSibling).toHaveTextContent('1');
    expect(screen.getByText(/"status": 200/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Execute|Retry|Approve|Cancel action/ })).not.toBeInTheDocument();
  });

  it('a clean failure: nothing was applied, so it can simply be retried', async () => {
    const api = fakeApi({ 'GET /remediations/act-1': { ...remediation, status: 'FAILED', approvalsGranted: 1, attempts: 1, executionResult: result('not_applied', 'The webhook refused the request (HTTP 422).') }, 'POST /remediations/act-1/retry': { ok: true } });
    show(<RemediationDetailPage />, ada);

    expect(await screen.findByText('The webhook refused the request (HTTP 422).')).toBeInTheDocument();
    expect(screen.getByText('Outcome').nextElementSibling).toHaveTextContent('Not applied');
    expect(screen.queryByText('The outcome of the last attempt is unknown.')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.writes()).toEqual([{ method: 'POST', path: '/remediations/act-1/retry', body: {} }]));
  });

  it('an unknown outcome: is never shown as failed-and-safe, and a retry needs an explicit confirmation', async () => {
    const api = fakeApi({ 'GET /remediations/act-1': { ...remediation, status: 'FAILED', approvalsGranted: 1, attempts: 1, executionResult: result('unknown', 'The webhook did not answer within 10 s.') }, 'POST /remediations/act-1/retry': { ok: true } });
    show(<RemediationDetailPage />, ada);

    expect(await screen.findByText('The outcome of the last attempt is unknown.')).toBeInTheDocument();
    expect(screen.getByText(/the change may or may not have been applied/)).toBeInTheDocument();
    expect(screen.getByText('Outcome').nextElementSibling).toHaveTextContent('Unknown: may or may not have been applied');
    // No one-click retry: the plain button is replaced by one that opens a confirmation.
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry…' }));
    expect(api.writes()).toEqual([]);

    const dialog = screen.getByRole('dialog', { name: 'Retry after an unknown outcome' });
    expect(dialog).toHaveTextContent('a receiver that does not honour the key would apply it twice');
    await userEvent.click(within(dialog).getByRole('button', { name: 'I have checked: it was not applied' }));
    await waitFor(() => expect(api.writes()).toEqual([{ method: 'POST', path: '/remediations/act-1/retry', body: { confirmNotApplied: true } }]));
  });

  it('without a webhook: the person carries the change out and confirms it, with notes', async () => {
    const api = fakeApi({ 'GET /remediations/act-1': { ...remediation, status: 'APPROVED', approvalsGranted: 1, executionMode: 'manual' }, 'POST /remediations/act-1/execute': { ok: true } });
    show(<RemediationDetailPage />, ada);

    await userEvent.click(await screen.findByRole('button', { name: 'Mark as executed' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm manual execution' });
    expect(dialog).toHaveTextContent('OPSILUME is not connected to your infrastructure.');
    await userEvent.type(within(dialog).getByLabelText('Notes (optional)'), 'kubectl rollout undo deploy/checkout');
    await userEvent.click(within(dialog).getByRole('button', { name: 'I have carried this out' }));
    await waitFor(() => expect(api.writes()).toEqual([{ method: 'POST', path: '/remediations/act-1/execute', body: { confirmManual: true, notes: 'kubectl rollout undo deploy/checkout' } }]));
  });

  it('a viewer sees the outcome but can neither retry nor execute', async () => {
    fakeApi({ 'GET /remediations/act-1': { ...remediation, status: 'FAILED', approvalsGranted: 1, attempts: 1, executionResult: result('unknown', 'The webhook did not answer within 10 s.') } });
    show(<RemediationDetailPage />, session('VIEWER', { id: 'user-vic', name: 'Vic Viewer' }));
    expect(await screen.findByText('The outcome of the last attempt is unknown.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry|Execute/ })).not.toBeInTheDocument();
  });
});

describe('connecting integrations', () => {
  const source = (over: Partial<Integration>): Integration => ({
    id: 'logs', name: 'Logs', kind: 'push', scope: 'organization', provides: 'Application log lines.', requires: ['An API key with the scope ingest:logs.'],
    status: 'not_configured', statusDetail: 'No API key with the scope ingest:logs exists, and no data has been received.', lastReceivedAt: null, lastError: null, lastCheck: null,
    facts: [{ label: 'API keys with this scope', value: '0' }], setup: { endpoint: 'POST /api/v1/logs', apiKeyScope: 'ingest:logs', example: '{"service":"checkout-service","logs":[]}', settingsTab: 'keys', canCheck: false }, ...over,
  });
  const github = source({ id: 'github', name: 'GitHub', kind: 'pull', status: 'connected', statusDetail: 'The token was accepted by GitHub (account acme-bot). No repository is connected yet.', setup: { endpoint: null, apiKeyScope: null, example: null, settingsTab: 'github', canCheck: true } });
  const engine = source({ id: 'analysis_engine', name: 'Analysis engine', kind: 'engine', scope: 'installation', status: 'connected', statusDetail: 'The rule-based engine is active. No model is called and nothing is billed.', setup: { endpoint: null, apiKeyScope: null, example: null, settingsTab: null, canCheck: false } });
  const steps = (done: number) => ['services', 'source', 'connect', 'data', 'associate', 'investigate'].map((id, i) => ({ id, title: `Step ${id}`, done: i < done, detail: `Detail of ${id}`, href: id === 'services' ? '/services' : '/integrations' }));
  const overview = (over: Partial<IntegrationOverview> = {}): IntegrationOverview => ({ generatedAt: '2026-11-14T09:00:00.000Z', integrations: [source({}), github, engine], unresolvedServices: [], onboarding: { complete: false, steps: steps(1) }, ...over });

  it('tells saved, connected and receiving apart, and shows how to connect without ever showing a key', async () => {
    fakeApi({ 'GET /integrations': overview({ integrations: [source({}), source({ id: 'metrics', name: 'Metrics', status: 'delivering', statusDetail: 'Receiving data: 120 samples in the last 24 hours.', lastReceivedAt: new Date().toISOString() }), source({ id: 'deployments', name: 'Deployments', status: 'configured', statusDetail: '1 API key can send this data. None has been used yet.' }), github, engine] }), 'GET /services': { data: [], meta: { page: 1, pageSize: 100, total: 0, totalPages: 0 } } });
    show(<IntegrationsPage />, session('ADMIN'));
    expect(await screen.findByText('Not set up')).toBeInTheDocument();
    expect(screen.getByText('Receiving data')).toBeInTheDocument();
    expect(screen.getByText('Set up, not yet verified')).toBeInTheDocument();
    expect(screen.getByText('Connected, no data yet')).toBeInTheDocument(); // GitHub: token accepted, nothing read
    expect(screen.getByText('Connected')).toBeInTheDocument(); // the engine: connected is all there is
    // The list of steps says what is done and what comes next.
    expect(screen.getByText('1 of 6 steps done.', { exact: false })).toBeInTheDocument();
    expect(screen.getByTestId('step-services')).toHaveAttribute('data-done', 'true');
    expect(within(screen.getByTestId('step-source')).getByText('next')).toBeInTheDocument();
    // How to connect: the request to send, with a placeholder where the key goes.
    await userEvent.click(screen.getAllByRole('button', { name: 'How to connect' })[0]!);
    const example = screen.getByText(/curl -X POST/);
    expect(example.textContent).toContain('/api/v1/logs');
    expect(example.textContent).toContain('$OPSILUME_API_KEY');
    expect(example.textContent).not.toMatch(/opk_[A-Za-z0-9]/);
    expect(screen.getByText('An API key with the scope ingest:logs.')).toBeInTheDocument();
  });

  it('runs a connection check on request and shows what it found, including a failure in plain words', async () => {
    let current = github;
    const api = fakeApi({
      'GET /integrations': () => overview({ integrations: [current, engine] }),
      'GET /services': { data: [], meta: { page: 1, pageSize: 100, total: 0, totalPages: 0 } },
      'POST /integrations/github/check': () => {
        current = { ...github, status: 'unavailable', statusDetail: 'The last connection check failed.', lastCheck: { at: new Date().toISOString(), ok: false, detail: 'GitHub rejected the token (401). Check that it is valid and not expired.' } };
        return { ok: false, detail: current.lastCheck!.detail };
      },
    });
    show(<IntegrationsPage />, session('ADMIN'));
    await userEvent.click(await screen.findByRole('button', { name: 'Check connection' }));
    expect(await screen.findByText('Not working')).toBeInTheDocument();
    expect(screen.getByText(/GitHub rejected the token \(401\)/)).toBeInTheDocument();
    expect(api.writes().map((c) => `${c.method} ${c.path}`)).toEqual(['POST /integrations/github/check']);
  });

  it('does not offer checks or linking to someone who may not use them', async () => {
    fakeApi({ 'GET /integrations': overview({ integrations: [github, engine], unresolvedServices: [{ ref: 'payments-api', sources: ['logs'], count: 12, lastSeenAt: new Date().toISOString(), linkable: true, registered: false }] }), 'GET /services': { data: [], meta: { page: 1, pageSize: 100, total: 0, totalPages: 0 } } });
    show(<IntegrationsPage />, session('VIEWER'));
    expect(await screen.findByText('payments-api')).toBeInTheDocument();
    expect(screen.getByText(/12 log lines stored without a service/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check connection' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Give these lines to it' })).not.toBeInTheDocument();
  });

  it('gives stored log lines to a service once it exists', async () => {
    let linked = false;
    const api = fakeApi({
      'GET /integrations': () => overview({ unresolvedServices: linked ? [] : [{ ref: 'payments-api', sources: ['logs'], count: 12, lastSeenAt: new Date().toISOString(), linkable: true, registered: true }] }),
      'GET /services': { data: [{ id: 'svc-1', name: 'Payments API', slug: 'payments-api' }], meta: { page: 1, pageSize: 100, total: 1, totalPages: 1 } },
      'POST /integrations/unresolved-services/link': () => {
        linked = true;
        return { linked: 12 };
      },
    });
    show(<IntegrationsPage />, session('ENGINEER'));
    // The service of the same name is already chosen.
    await userEvent.click(await screen.findByRole('button', { name: 'Give these lines to it' }));
    await waitFor(() => expect(screen.queryByText('Data that belongs to no service')).not.toBeInTheDocument());
    expect(api.writes()).toEqual([{ method: 'POST', path: '/integrations/unresolved-services/link', body: { ref: 'payments-api', service: 'payments-api' } }]);
  });
});
