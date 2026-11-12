import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reportSchema } from '../src/modules/investigations';

/** Every key path in a JSON value, with list items collapsed. */
function shape(value: unknown, prefix = ''): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(value)) {
    for (const item of value) for (const p of shape(item, `${prefix}[].`)) out.add(p);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(`${prefix}${k}`);
      for (const p of shape(v, `${prefix}${k}.`)) out.add(p);
    }
  }
  return out;
}

describe('report contract with the AI service', () => {
  // Written by the AI service's own test suite from a real investigation run
  // (services/ai/tests/test_agent.py). Both suites read the same file, so the two
  // definitions of the report cannot drift apart unnoticed.
  const fixture = JSON.parse(readFileSync(join(__dirname, '../../../services/ai/tests/fixtures/report.contract.json'), 'utf8'));

  it('accepts what the AI service actually emits', () => {
    const parsed = reportSchema.safeParse(fixture);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('keeps every field the AI service sends', () => {
    const parsed = reportSchema.parse(fixture);
    // Parameters are free-form on the API side; everything else must survive parsing.
    const sent = [...shape(fixture)].filter((p) => !p.startsWith('recommendedActions.[].parameters.'));
    const kept = shape(parsed);
    expect(sent.filter((p) => !kept.has(p))).toEqual([]);
  });
});
