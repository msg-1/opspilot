'use client';

import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { compact, shortTime } from '@/lib/format';

/**
 * Chart conventions (one place, so every chart agrees):
 *  - status colours (critical / serious / warning) only for severity and error/warning series;
 *    a single measured series is blue; text is always ink, never the series colour
 *  - 2px lines, bars with 4px rounded data-ends and a 2px surface gap between stacked segments
 *  - hairline grid, one y-axis, crosshair/hover tooltip on every chart, legend when there are 2+ series
 */
export const CHART = {
  series: '#2a78d6',
  series2: '#eb6834',
  critical: '#d03b3b',
  serious: '#ec835a',
  warning: '#fab219',
  neutral: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  text: '#7c7a74',
  surface: '#ffffff',
};

export interface SeriesDef {
  key: string;
  label: string;
  color: string;
}

const axisTick = { fontSize: 11, fill: CHART.text };

function ChartTooltip({ active, payload, label, series, unit, labelFormat }: { active?: boolean; payload?: { dataKey: string; value: number }[]; label?: string | number; series: SeriesDef[]; unit?: string; labelFormat: (v: string) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-[12px] shadow-pop">
      <div className="mb-1 font-medium text-ink">{labelFormat(String(label))}</div>
      {series.map((s) => {
        const item = payload.find((p) => p.dataKey === s.key);
        if (!item) return null;
        return (
          <div key={s.key} className="flex items-center justify-between gap-4 text-ink-2">
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block size-2 rounded-sm" style={{ background: s.color }} />
              {s.label}
            </span>
            <span className="tabular font-medium text-ink">
              {compact(item.value)}
              {unit ? ` ${unit}` : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function Legend({ series }: { series: SeriesDef[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: s.color }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

function Empty({ height, message }: { height: number; message: string }) {
  return (
    <div className="flex items-center justify-center text-[13px] text-ink-3" style={{ height }}>
      {message}
    </div>
  );
}

/** Accessible alternative to the plot: the same numbers as a table for screen readers. */
function DataTable<T extends Record<string, unknown>>({ data, xKey, series, caption, format }: { data: T[]; xKey: string; series: SeriesDef[]; caption: string; format: (v: string) => string }) {
  // A <table> ignores the 1px clip box of sr-only, so the wrapper is what gets hidden.
  return (
    <div className="sr-only">
    <table>
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th>Time</th>
          {series.map((s) => (
            <th key={s.key}>{s.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.slice(-60).map((row, i) => (
          <tr key={i}>
            <td>{format(String(row[xKey]))}</td>
            {series.map((s) => (
              <td key={s.key}>{String(row[s.key] ?? '')}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

interface BaseProps<T> {
  data: T[];
  xKey: string;
  series: SeriesDef[];
  height?: number;
  unit?: string;
  caption: string;
  /** Time axis: x values are ISO timestamps */
  time?: boolean;
  withDate?: boolean;
  emptyMessage?: string;
}

const formatter = (time: boolean | undefined, withDate: boolean | undefined) => (v: string) => (time ? shortTime(v, withDate) : v);

export function StackedBars<T extends Record<string, unknown>>({ data, xKey, series, height = 200, unit, caption, time, withDate, emptyMessage = 'No data in this period' }: BaseProps<T>) {
  const fmt = formatter(time, withDate);
  if (!data.length) return <Empty height={height} message={emptyMessage} />;
  return (
    <figure aria-label={caption}>
      <Legend series={series} />
      <div style={{ height }} aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -18 }} barCategoryGap="22%">
            <CartesianGrid vertical={false} stroke={CHART.grid} />
            <XAxis dataKey={xKey} tickFormatter={fmt} tick={axisTick} tickLine={false} axisLine={{ stroke: CHART.axis }} minTickGap={28} />
            <YAxis tick={axisTick} tickLine={false} axisLine={false} allowDecimals={false} tickFormatter={(v) => compact(v)} />
            <Tooltip cursor={{ fill: 'rgb(22 24 29 / 0.04)' }} content={<ChartTooltip series={series} unit={unit} labelFormat={(v) => (time ? shortTime(v, true) : v)} />} />
            {series.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} stackId="a" fill={s.color} stroke={CHART.surface} strokeWidth={series.length > 1 ? 2 : 0} radius={i === series.length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={28} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <DataTable data={data} xKey={xKey} series={series} caption={caption} format={fmt} />
    </figure>
  );
}

export function Lines<T extends Record<string, unknown>>({ data, xKey, series, height = 200, unit, caption, time = true, withDate, emptyMessage = 'No data in this period', threshold, markers }: BaseProps<T> & { threshold?: number; markers?: { at: string; label: string }[] }) {
  const fmt = formatter(time, withDate);
  if (!data.length) return <Empty height={height} message={emptyMessage} />;
  return (
    <figure aria-label={caption}>
      <Legend series={series} />
      <div style={{ height }} aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: -14 }}>
            <CartesianGrid vertical={false} stroke={CHART.grid} />
            <XAxis dataKey={xKey} tickFormatter={fmt} tick={axisTick} tickLine={false} axisLine={{ stroke: CHART.axis }} minTickGap={36} />
            <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={(v) => compact(v)} width={48} />
            <Tooltip cursor={{ stroke: CHART.axis, strokeWidth: 1 }} content={<ChartTooltip series={series} unit={unit} labelFormat={(v) => (time ? shortTime(v, true) : v)} />} />
            {threshold !== undefined && <ReferenceLine y={threshold} stroke={CHART.critical} strokeDasharray="4 3" strokeWidth={1} label={{ value: `threshold ${compact(threshold)}`, position: 'insideTopRight', fontSize: 10, fill: CHART.text }} />}
            {markers?.map((m) => (
              <ReferenceLine key={m.at + m.label} x={m.at} stroke={CHART.neutral} strokeDasharray="2 3" label={{ value: m.label, position: 'top', fontSize: 10, fill: CHART.text }} />
            ))}
            {series.map((s) => (
              <Line key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: CHART.surface, strokeWidth: 2 }} isAnimationActive={false} connectNulls />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <DataTable data={data} xKey={xKey} series={series} caption={caption} format={fmt} />
    </figure>
  );
}

/** Word-sized trend with no axes; the number beside it carries the value. */
export function Sparkline({ data, color = CHART.series, label }: { data: { value: number }[]; color?: string; label: string }) {
  if (data.length < 2) return <span className="text-[12px] text-ink-3">no data</span>;
  return (
    <div className="h-7 w-24" role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <Area type="monotone" dataKey="value" stroke={color} strokeWidth={1.5} fill={color} fillOpacity={0.12} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export const SEVERITY_SERIES: SeriesDef[] = [
  { key: 'SEV1', label: 'SEV1', color: CHART.critical },
  { key: 'SEV2', label: 'SEV2', color: CHART.serious },
  { key: 'SEV3', label: 'SEV3', color: CHART.warning },
  { key: 'SEV4', label: 'SEV4', color: CHART.neutral },
];

export const ERROR_SERIES: SeriesDef[] = [
  { key: 'errors', label: 'Errors', color: CHART.critical },
  { key: 'warnings', label: 'Warnings', color: CHART.warning },
];
