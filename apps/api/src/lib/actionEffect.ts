/**
 * What carrying out an action would do to production: only look, or change something.
 *
 * The type is not enough: "run_runbook" and "manual" can be a harmless check or a cache flush,
 * so their text is read. The rule is conservative. An action is read-only only when it says what
 * it inspects and mentions nothing that changes state; anything unclear is state-changing,
 * because a state-changing action is the one that needs a human's approval.
 *
 * The rules themselves are data: contracts/action-effects.json is the one definition, generated
 * into src/generated/contracts.ts for the API and into the AI service, where
 * services/ai/app/effects.py applies them the same way. Both test suites check
 * contracts/fixtures/action-effects.json.
 */
import { ACTION_EFFECT_RULES as RULES, type ActionEffect } from '../generated/contracts';

export type { ActionEffect };

/** Types that change production whatever their description says. */
export const STATE_CHANGING_TYPES = new Set<string>(RULES.stateChangingTypes);

// Verb stems are matched as whole words with common endings, case-insensitively.
const CHANGING = RULES.changing.map((rule) => ({
  label: rule.label,
  plain: new RegExp(`\\b(?:${rule.pattern})`, 'i'),
  // A configuration verb followed by a constant-style name ("Lower DB_POOL_MAX"). The verb may
  // be in any case, the name must be upper case, so this part is matched in two steps.
  verbThen: 'verbThenConstant' in rule ? new RegExp(`\\b(?:${rule.verbThenConstant.verbs}) (\\S+)`, 'gi') : null,
  constant: 'verbThenConstant' in rule ? new RegExp(`^${rule.verbThenConstant.constant}\\b`) : null,
}));
const READING = new RegExp(`\\b(?:${RULES.reading})`, 'i');

/** The earliest occurrence in the text of either form of the rule. */
function firstMatch(text: string, rule: (typeof CHANGING)[number]): string | null {
  const found: [number, string][] = [];
  const plain = rule.plain.exec(text);
  if (plain) found.push([plain.index, plain[0]]);
  if (rule.verbThen && rule.constant) {
    for (const m of text.matchAll(rule.verbThen)) {
      if (rule.constant.test(m[1]!)) {
        found.push([m.index, m[0]]);
        break;
      }
    }
  }
  return found.length ? found.sort((a, b) => a[0] - b[0])[0]![1] : null;
}

export function classifyText(text: string): { effect: ActionEffect; reasons: string[] } {
  const found: string[] = [];
  for (const rule of CHANGING) {
    const match = firstMatch(text, rule);
    if (match) found.push(`${rule.label} ("${match.trim()}")`);
  }
  if (found.length) return { effect: 'state_changing', reasons: found };
  if (READING.test(text)) return { effect: 'read_only', reasons: [RULES.reasons.readOnly] };
  return { effect: 'state_changing', reasons: [RULES.reasons.unclear] };
}

/** Effect of an action. `steps` are the steps of the runbook it refers to, if known. */
export function actionEffect(type: string, title = '', description = '', steps: string[] = []): { effect: ActionEffect; reasons: string[] } {
  if (STATE_CHANGING_TYPES.has(type)) return { effect: 'state_changing', reasons: [RULES.reasons.byType.replace('{type}', type)] };
  return classifyText([title, description, ...steps].join(' . '));
}

export interface RunbookStep {
  index: number;
  section: string | null;
  text: string;
  effect: ActionEffect;
  reasons: string[];
}

/**
 * Turns a runbook written in Markdown into an execution plan: its list items and numbered steps,
 * each labelled with what it would do. Reading and explaining a runbook never needs approval;
 * this plan is what tells a human which of its steps would.
 */
export function runbookPlan(markdown: string): { steps: RunbookStep[]; effect: ActionEffect; stateChanging: number } {
  const steps: RunbookStep[] = [];
  let section: string | null = null;
  let inCode = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading && !inCode) {
      section = heading[1]!.trim();
      continue;
    }
    const item = inCode ? (line ? [line, line] : null) : /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line);
    if (!item) continue;
    const text = item[1]!.trim();
    // A command in a code block is judged as a command: unknown commands count as state-changing.
    const { effect, reasons } = classifyText(text);
    steps.push({ index: steps.length + 1, section, text: text.slice(0, 500), effect, reasons });
  }
  const stateChanging = steps.filter((s) => s.effect === 'state_changing').length;
  // A runbook with no recognisable steps cannot be shown to be harmless.
  return { steps, stateChanging, effect: steps.length && !stateChanging ? 'read_only' : 'state_changing' };
}
