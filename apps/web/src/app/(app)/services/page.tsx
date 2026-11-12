'use client';

import { Boxes, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { DeploymentStatusBadge, HealthBadge, TierBadge } from '@/components/badges';
import { Button, Card, EmptyState, ErrorState, Input, Mono, PageHeader, Select, Spinner, Table } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { ServiceForm } from '@/components/service-form';
import type { Paged, Service } from '@/lib/types';

interface Row extends Service {
  lastDeployment: { version: string; status: string; startedAt: string } | null;
  dependencyCount: number;
  dependentCount: number;
  openIncidents: number;
}

export default function ServicesPage() {
  const session = useSession();
  const [search, setSearch] = useState('');
  const [health, setHealth] = useState('');
  const [adding, setAdding] = useState(false);
  const q = useDebounced(search);
  const { data, error, isLoading, refetch } = useApi<Paged<Row>>(`/services${qs({ q, health })}`, { refetchInterval: 30_000, placeholderData: (p) => p });

  return (
    <>
      <PageHeader title="Services" description="The catalogue of what you run: ownership, dependencies, health and recent changes." actions={session.can('service:write') && <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setAdding(true)}>Add service</Button>} />
      <div className="mb-3 flex flex-wrap gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-ink-3" aria-hidden />
          <Input aria-label="Search services" placeholder="Search by name, description or tag" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select aria-label="Health" className="w-40" value={health} onChange={(e) => setHealth(e.target.value)}>
          <option value="">Any health</option><option value="DOWN">Down</option><option value="DEGRADED">Degraded</option><option value="HEALTHY">Healthy</option><option value="UNKNOWN">No data</option>
        </Select>
      </div>
      <Card padded={false}>
        {error ? <div className="p-4"><ErrorState error={error} retry={() => void refetch()} /></div> : isLoading || !data ? <Spinner /> : data.data.length === 0 ? (
          <EmptyState icon={<Boxes className="size-5" aria-hidden />} title={q || health ? 'No services match' : 'No services yet'} description={q || health ? 'Clear the filters to see every service.' : 'Add your services so logs, deployments and incidents can be tied to them.'} action={!q && !health && session.can('service:write') ? <Button size="sm" onClick={() => setAdding(true)}>Add your first service</Button> : undefined} />
        ) : (
          <Table head={<><th>Service</th><th>Health</th><th>Tier</th><th>Owner</th><th>Last deployment</th><th className="text-right">Depends on</th><th className="text-right">Used by</th><th className="text-right">Open incidents</th></>}>
            {data.data.map((s) => (
              <tr key={s.id} className="hover:bg-sunken/50">
                <td className="max-w-[22rem]"><Link href={`/services/${s.id}`} className="font-medium hover:underline">{s.name}</Link><div className="truncate text-[12px] text-ink-2">{s.description ?? <Mono>{s.slug}</Mono>}</div></td>
                <td><HealthBadge health={s.health} /></td>
                <td><TierBadge tier={s.tier} /></td>
                <td className="whitespace-nowrap text-ink-2">{s.ownerTeam?.name ?? '—'}</td>
                <td className="whitespace-nowrap">{s.lastDeployment ? <span className="flex items-center gap-2"><Mono>{s.lastDeployment.version}</Mono><DeploymentStatusBadge status={s.lastDeployment.status} /><span className="text-[12px] text-ink-2">{timeAgo(s.lastDeployment.startedAt)}</span></span> : <span className="text-ink-3">Never</span>}</td>
                <td className="tabular text-right text-ink-2">{s.dependencyCount}</td>
                <td className="tabular text-right text-ink-2">{s.dependentCount}</td>
                <td className="tabular text-right">{s.openIncidents ? <span className="font-semibold text-critical-ink">{s.openIncidents}</span> : <span className="text-ink-3">0</span>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {adding && <ServiceForm open onClose={() => setAdding(false)} />}
    </>
  );
}
