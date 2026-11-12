/**
 * What carrying out an action would do to production: only look, or change something.
 *
 * The type is not enough: "run_runbook" and "manual" can be a harmless check or a cache flush,
 * so their text is read. The rule is conservative. An action is read-only only when it says what
 * it inspects and mentions nothing that changes state; anything unclear is state-changing,
 * because a state-changing action is the one that needs a human's approval.
 *
 * services/ai/app/effects.py implements the same rules. Both test suites check
 * services/ai/tests/fixtures/action-effects.json, so the two cannot drift apart.
 */
export type ActionEffect = 'read_only' | 'state_changing';

/** Types that change production whatever their description says. */
export const STATE_CHANGING_TYPES = new Set(['rollback_deployment', 'restart_service', 'scale_service', 'toggle_feature_flag', 'config_change']);

const CONFIG_VERBS = 'change|changing|modify|modifying|edit|editing|update|updating|adjust|adjusting|tune|tuning|override|overriding|raise|raising|lower|lowering|increase|increasing|decrease|decreasing|bump|bumping';

const CHANGING: [string, RegExp][] = [
  ['restarts or stops a process', /\b(?:restart\w*|reboot\w*|kill\w*|terminat\w*|shut\s?down|stop(?:ping)? (?:the|a|all|every)\b|bounce\w*)/i],
  ['deploys or rolls back a version', /\b(?:deploy(?:ing|s)?\b|redeploy\w*|roll(?:ing|ed)?[\s-]?back|revert\w*|promot(?:e|ing)\b|hotfix\w*|releas(?:e|ing) (?:a|the|new)\b)/i],
  // Verbs with an object: "change the pool size", not "no change should be made" or "what changed".
  ['changes configuration', new RegExp(`\\b(?:reconfigur\\w*|(?:${CONFIG_VERBS}) (?:the|a|an|its|this|that|their|it|[A-Za-z]+[_.][A-Za-z_.]+)\\b|set(?:ting)? (?:the\\b|[A-Za-z_.]+ ?(?:=|to\\b)))`, 'i')],
  ['turns something on or off', /\b(?:toggl\w*|enabl(?:e|ing)\b|disabl(?:e|ing)\b|turn(?:ing)? (?:on|off)\b|switch(?:ing)? (?:on|off|over|to)\b|paus(?:e|ing)\b|resum(?:e|ing)\b)/i],
  ['clears a queue, cache or data', /\b(?:flush\w*|purg\w*|clear(?:ing)?\b|evict\w*|invalidat\w*|drain\w*|delet(?:e|ing)\b|drop(?:ping)?\b|truncat\w*|wip(?:e|ing)\b|remov(?:e|ing)\b|reset\w*|requeue\w*|replay\w*)/i],
  ['runs a migration or writes data', /\b(?:migrat\w*|backfill\w*|reindex\w*|rebuild\w*|restor(?:e|ing)\b|(?:insert|update|delete|alter|create|grant|revoke) (?:into|table|from|index|user|role)\b|write(?:s|ing)? to\b)/i],
  ['changes capacity or infrastructure', /\b(?:scal(?:e|ing)\b|resiz\w*|provision\w*|fail[\s-]?over|add(?:ing)? (?:a |more )?(?:replica|node|instance|capacity)\w*|terraform apply|kubectl (?:apply|delete|scale|rollout|edit|patch|set|cordon|drain)|systemctl (?:start|stop|restart|reload)|helm (?:upgrade|install|rollback|uninstall))/i],
  ['changes access', /\b(?:rotat(?:e|ing)\b|revok(?:e|ing)\b|grant(?:ing)?\b|chmod|chown|permission change|change (?:the )?permissions)/i],
  ['upgrades or patches software', /\b(?:upgrad\w*|downgrad\w*|patch(?:ing)?\b|apply(?:ing)? (?:the|a)\b|install\w*|uninstall\w*)/i],
];
// A configuration verb followed by a constant-style name: "Lower DB_POOL_MAX". The verb may be in
// any case, the name must be upper case, so this one is matched in two steps.
const CONFIG_VERB_THEN = new RegExp(`\\b(?:${CONFIG_VERBS}) (\\S+)`, 'gi');
const CONSTANT_NAME = /^[A-Z][A-Z0-9_]{2,}\b/;
const READING =
  /\b(?:check\w*|verif\w*|confirm\w*|inspect\w*|review\w*|read\w*|look\w*|view\w*|examin\w*|compar\w*|monitor\w*|observ\w*|watch\w*|quer(?:y|ies|ying)|list\w*|describ\w*|fetch\w*|search\w*|investigat\w*|analy[sz]\w*|trac(?:e|ing)\b|measur\w*|collect\w*|captur\w*|gather\w*|identif\w*|determin\w*|ask\w*|contact\w*|notif\w*|escalat\w*|document\w*|record\w*|note\b|open (?:the )?(?:dashboard|log|trace)\w*)/i;

export function classifyText(text: string): { effect: ActionEffect; reasons: string[] } {
  const found: string[] = [];
  for (const [label, rx] of CHANGING) {
    let match = rx.exec(text)?.[0];
    if (!match && label === 'changes configuration') {
      for (const m of text.matchAll(CONFIG_VERB_THEN)) {
        if (CONSTANT_NAME.test(m[1]!)) match = m[0];
      }
    }
    if (match) found.push(`${label} ("${match.trim()}")`);
  }
  if (found.length) return { effect: 'state_changing', reasons: found };
  if (READING.test(text)) return { effect: 'read_only', reasons: ['only inspects, and names nothing that changes state'] };
  return { effect: 'state_changing', reasons: ['its effect cannot be told from the description, so it is treated as state-changing'] };
}

/** Effect of an action. `steps` are the steps of the runbook it refers to, if known. */
export function actionEffect(type: string, title = '', description = '', steps: string[] = []): { effect: ActionEffect; reasons: string[] } {
  if (STATE_CHANGING_TYPES.has(type)) return { effect: 'state_changing', reasons: [`${type} changes production by definition`] };
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
