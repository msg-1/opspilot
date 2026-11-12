"""What a recommended action would do to production: only look, or change something.

The action's type is not enough. "run_runbook" and "manual" can be a harmless check or a cache
flush, so their text is read. The rule is conservative: an action is read-only only when it says
what it inspects and mentions nothing that changes state. Anything unclear is treated as
state-changing, because a state-changing action is the one that needs a human's approval.

apps/api/src/lib/actionEffect.ts implements the same rules; tests/fixtures/action-effects.json is
checked by both test suites so the two cannot drift apart.
"""

from __future__ import annotations

import re
from typing import Literal

Effect = Literal["read_only", "state_changing"]

#: Types that change production whatever their description says.
STATE_CHANGING_TYPES = {"rollback_deployment", "restart_service", "scale_service", "toggle_feature_flag", "config_change"}

# (what it does, pattern). Verb stems are matched as whole words with common endings.
_CHANGING: list[tuple[str, str]] = [
    ("restarts or stops a process", r"restart\w*|reboot\w*|kill\w*|terminat\w*|shut\s?down|stop(?:ping)? (?:the|a|all|every)\b|bounce\w*"),
    ("deploys or rolls back a version", r"deploy(?:ing|s)?\b|redeploy\w*|roll(?:ing|ed)?[\s-]?back|revert\w*|promot(?:e|ing)\b|hotfix\w*|releas(?:e|ing) (?:a|the|new)\b"),
    # Verbs with an object: "change the pool size", not "no change should be made" or "what changed".
    ("changes configuration", r"reconfigur\w*|(?:change|changing|modify|modifying|edit|editing|update|updating|adjust|adjusting|tune|tuning|override|overriding|raise|raising|lower|lowering|increase|increasing|decrease|decreasing|bump|bumping) (?:the|a|an|its|this|that|their|it|[A-Za-z]+[_.][A-Za-z_.]+|(?-i:[A-Z][A-Z0-9_]{2,}))\b|\bset(?:ting)? (?:the\b|[A-Za-z_.]+ ?(?:=|to\b))"),
    ("turns something on or off", r"toggl\w*|enabl(?:e|ing)\b|disabl(?:e|ing)\b|turn(?:ing)? (?:on|off)\b|switch(?:ing)? (?:on|off|over|to)\b|paus(?:e|ing)\b|resum(?:e|ing)\b"),
    ("clears a queue, cache or data", r"flush\w*|purg\w*|clear(?:ing)?\b|evict\w*|invalidat\w*|drain\w*|delet(?:e|ing)\b|drop(?:ping)?\b|truncat\w*|wip(?:e|ing)\b|remov(?:e|ing)\b|reset\w*|requeue\w*|replay\w*"),
    ("runs a migration or writes data", r"migrat\w*|backfill\w*|reindex\w*|rebuild\w*|restor(?:e|ing)\b|\b(?:insert|update|delete|alter|create|grant|revoke) (?:into|table|from|index|user|role)\b|write(?:s|ing)? to\b"),
    ("changes capacity or infrastructure", r"scal(?:e|ing)\b|resiz\w*|provision\w*|fail[\s-]?over|add(?:ing)? (?:a |more )?(?:replica|node|instance|capacity)\w*|terraform apply|kubectl (?:apply|delete|scale|rollout|edit|patch|set|cordon|drain)|systemctl (?:start|stop|restart|reload)|helm (?:upgrade|install|rollback|uninstall)"),
    ("changes access", r"rotat(?:e|ing)\b|revok(?:e|ing)\b|grant(?:ing)?\b|chmod|chown|permission change|change (?:the )?permissions"),
    ("upgrades or patches software", r"upgrad\w*|downgrad\w*|patch(?:ing)?\b|apply(?:ing)? (?:the|a)\b|install\w*|uninstall\w*"),
]
_READING = (
    r"check\w*|verif\w*|confirm\w*|inspect\w*|review\w*|read\w*|look\w*|view\w*|examin\w*|compar\w*|monitor\w*|observ\w*|watch\w*|quer(?:y|ies|ying)|list\w*|describ\w*|"
    r"fetch\w*|search\w*|investigat\w*|analy[sz]\w*|trac(?:e|ing)\b|measur\w*|collect\w*|captur\w*|gather\w*|identif\w*|determin\w*|ask\w*|contact\w*|notif\w*|escalat\w*|"
    r"document\w*|record\w*|note\b|open (?:the )?(?:dashboard|log|trace)\w*"
)
_CHANGING_RE = [(label, re.compile(rf"\b(?:{pattern})", re.IGNORECASE)) for label, pattern in _CHANGING]
_READING_RE = re.compile(rf"\b(?:{_READING})", re.IGNORECASE)


def classify_text(text: str) -> tuple[Effect, list[str]]:
    """(effect, why). `why` names what the text would change, or says why it counts as read-only."""
    found = [f'{label} ("{m.group(0).strip()}")' for label, rx in _CHANGING_RE if (m := rx.search(text))]
    if found:
        return "state_changing", found
    if _READING_RE.search(text):
        return "read_only", ["only inspects, and names nothing that changes state"]
    return "state_changing", ["its effect cannot be told from the description, so it is treated as state-changing"]


def action_effect(type_: str, title: str = "", description: str = "", steps: list[str] | None = None) -> tuple[Effect, list[str]]:
    """Effect of a recommended action. `steps` are the steps of a runbook it refers to, if known."""
    if type_ in STATE_CHANGING_TYPES:
        return "state_changing", [f"{type_} changes production by definition"]
    return classify_text(" . ".join([title, description, *(steps or [])]))
