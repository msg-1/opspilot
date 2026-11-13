"""What a recommended action would do to production: only look, or change something.

The action's type is not enough. "run_runbook" and "manual" can be a harmless check or a cache
flush, so their text is read. The rule is conservative: an action is read-only only when it says
what it inspects and mentions nothing that changes state. Anything unclear is treated as
state-changing, because a state-changing action is the one that needs a human's approval.

The rules themselves are data: contracts/action-effects.json is the one definition, generated
into app/generated/contracts.py for this service and into the API, where
apps/api/src/lib/actionEffect.ts applies them the same way. contracts/fixtures/action-effects.json
is checked by both test suites.
"""

from __future__ import annotations

import re

from .generated.contracts import ACTION_EFFECT_RULES as RULES
from .generated.contracts import ActionEffect as Effect

#: Types that change production whatever their description says.
STATE_CHANGING_TYPES = set(RULES["stateChangingTypes"])

# Verb stems are matched as whole words with common endings, case-insensitively.
_CHANGING_RE = [
    (
        rule["label"],
        re.compile(rf"\b(?:{rule['pattern']})", re.IGNORECASE),
        # A configuration verb followed by a constant-style name ("Lower DB_POOL_MAX"). The verb may
        # be in any case, the name must be upper case, so this part is matched in two steps.
        re.compile(rf"\b(?:{rule['verbThenConstant']['verbs']}) (\S+)", re.IGNORECASE) if "verbThenConstant" in rule else None,
        re.compile(rf"^{rule['verbThenConstant']['constant']}\b") if "verbThenConstant" in rule else None,
    )
    for rule in RULES["changing"]
]
_READING_RE = re.compile(rf"\b(?:{RULES['reading']})", re.IGNORECASE)


def _first_match(text: str, plain: re.Pattern[str], verb_then: re.Pattern[str] | None, constant: re.Pattern[str] | None) -> str | None:
    """The earliest occurrence in the text of either form of the rule."""
    found = [(m.start(), m.group(0)) for m in [plain.search(text)] if m]
    if verb_then and constant:
        found += [(m.start(), m.group(0)) for m in verb_then.finditer(text) if constant.match(m.group(1))][:1]
    return min(found)[1] if found else None


def classify_text(text: str) -> tuple[Effect, list[str]]:
    """(effect, why). `why` names what the text would change, or says why it counts as read-only."""
    found = [f'{label} ("{match.strip()}")' for label, plain, verb_then, constant in _CHANGING_RE if (match := _first_match(text, plain, verb_then, constant))]
    if found:
        return "state_changing", found
    if _READING_RE.search(text):
        return "read_only", [RULES["reasons"]["readOnly"]]
    return "state_changing", [RULES["reasons"]["unclear"]]


def action_effect(type_: str, title: str = "", description: str = "", steps: list[str] | None = None) -> tuple[Effect, list[str]]:
    """Effect of a recommended action. `steps` are the steps of a runbook it refers to, if known."""
    if type_ in STATE_CHANGING_TYPES:
        return "state_changing", [RULES["reasons"]["byType"].replace("{type}", type_)]
    return classify_text(" . ".join([title, description, *(steps or [])]))
