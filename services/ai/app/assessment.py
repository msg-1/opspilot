"""Does the evidence show a fault at all?

Every engine (rule-based, mock, model) gets the same answer to this question, computed here from
the evidence items and from what was and was not examined. It is deliberately not left to the
report's author: a model asked "why is X failing?" tends to find a reason, and a report that
always names a cause is worthless on the day nothing is wrong.

Signals, by strength:
  strong    10 or more ERROR/FATAL lines in one pattern · error rate up by half or more and at
            least 1% · latency up by half or more and by at least 50 ms · a firing alert · a
            dependency or the service itself recorded as DOWN · traces failing
  moderate  3 to 9 ERROR/FATAL lines in one pattern · 50 or more new or spiking WARN lines ·
            error rate up by a quarter and at least 0.5% · latency up by a quarter and by at least
            20 ms · another metric moved by a quarter or more and by at least one whole unit ·
            a dependency or the service recorded as DEGRADED
  weak      anything else that was noticed: a few warnings, a couple of errors, a percentage
            change on a value that is close to zero

A percentage alone is never enough. A pool gauge that averages 0.1 connections and drops to 0
has fallen by 100% and means nothing; p95 latency going from 20 ms to 27 ms is up 35% and is
noise. Every metric rule therefore has an absolute floor as well as a relative one. These were
added after the first run against real telemetry reported a healthy service as degraded.

Outcome:
  INCIDENT      a strong signal, and a leading hypothesis at 0.25 confidence or more that cites
                something which can be a cause (a change, a dependency, a past incident, a trace),
                not only the symptoms
  DEGRADED      a strong signal without such a hypothesis, or moderate signals only
  HEALTHY       neither, and there is telemetry to judge by: metric samples, or log lines
  UNDETERMINED  neither, and the service sent nothing in the window (no metric samples and no
                log lines) or nothing could be queried: absence of evidence, not health

Confidence here is confidence in the OUTCOME. It grows with coverage (metrics that held steady,
logs searched and clean, a healthy status on record) and shrinks with every source that failed.
It is never a constant: a healthy verdict on thin telemetry says so in its number.
"""

from __future__ import annotations

from .evidence import EvidenceStore
from .schemas import Assessment, Fact, HypothesisOut, Signal

#: Evidence that can be a cause. A log pattern or a metric is the symptom: a hypothesis that
#: cites nothing else describes the failure without explaining it.
CAUSAL_KINDS = {"deployment", "deployment_impact", "service_event", "commit", "pull_request", "dependency", "incident", "alert", "trace"}
LATENCY_STRONG_MS = 50
LATENCY_MODERATE_MS = 20
LOG_TOOLS = ("find_log_anomalies", "get_log_patterns", "search_logs", "get_incident_context")
SUPPORTED_HYPOTHESIS = 0.25


def _metric_level(data: dict) -> str:
    name = str(data.get("metric") or "").lower()
    # Up from zero has no percentage; it counts as a rise of any size, and the level reached decides.
    change = 1000 if data.get("fromZero") else (data.get("changePercent") or 0)
    avg = data.get("avg") or 0
    delta = abs(avg - (data.get("baselineAvg") or 0))
    if "error" in name or "fail" in name or "5xx" in name:
        # A rate that doubles from 0.1% to 0.2% is noise; one that reaches 1% is not.
        return "strong" if change >= 50 and (avg >= 1 or data.get("unit") not in ("%", "")) else "moderate" if change >= 25 and avg >= 0.5 else "weak"
    if any(k in name for k in ("latency", "duration", "p95", "p99", "response_time")):
        # Compared in milliseconds: below these floors a change is within the resolution of a histogram.
        ms = delta * 1000 if data.get("unit") == "s" or name.endswith(("_seconds", "_s")) else delta
        return "strong" if change >= 50 and ms >= LATENCY_STRONG_MS else "moderate" if change >= 25 and ms >= LATENCY_MODERATE_MS else "weak"
    # Anything else (throughput, connections, queue depth, CPU): notable, never a failure on its
    # own, and only when it moved by a whole unit as well as by a quarter.
    return "moderate" if (abs(change) >= 25 or data.get("fromZero")) and delta >= 1 else "weak"


def find_signals(store: EvidenceStore, scope: list[str] | None = None) -> list[Signal]:
    out: list[Signal] = []
    for p in store.by_kind("log_pattern"):
        d = p.data or {}
        count, level = d.get("count") or 0, d.get("level")
        anomalous = d.get("kind") in ("new", "spike") or (d.get("ratio") or 0) >= 3
        if level in ("ERROR", "FATAL"):
            strength = "strong" if count >= 10 else "moderate" if count >= 3 else "weak"
        else:
            strength = "moderate" if count >= 50 and anomalous else "weak"
        out.append(Signal(level=strength, kind="logs", text=p.title, evidence_refs=[p.ref]))
    for m in store.by_kind("metric"):
        out.append(Signal(level=_metric_level(m.data or {}), kind="metric", text=m.title, evidence_refs=[m.ref]))  # type: ignore[arg-type]
    for a in store.by_kind("alert"):
        firing = "firing" in a.title.lower() or "(firing)" in a.title.lower()
        out.append(Signal(level="strong" if firing else "moderate", kind="alert", text=a.title, evidence_refs=[a.ref]))
    for d in store.by_kind("dependency"):
        out.append(Signal(level="strong" if "DOWN" in d.title else "moderate", kind="dependency", text=d.title, evidence_refs=[d.ref]))
    for h in store.by_kind("service_health"):
        health = (h.data or {}).get("health")
        if health in ("DOWN", "DEGRADED") and (not scope or h.service in scope):
            out.append(Signal(level="strong" if health == "DOWN" else "moderate", kind="health", text=h.title, evidence_refs=[h.ref]))
    failed = [t for t in store.by_kind("trace") if (t.data or {}).get("errorSpans")]
    if failed:
        out.append(Signal(level="strong" if len(failed) >= 3 else "moderate", kind="traces", text=f"{len(failed)} sampled trace(s) contain failed spans", evidence_refs=[t.ref for t in failed[:4]]))
    order = {"strong": 0, "moderate": 1, "weak": 2}
    return sorted(out, key=lambda s: order[s.level])


def missing_telemetry(store: EvidenceStore, scope: list[str], tool_failures: list[str]) -> list[str]:
    out = [f"A data source could not be queried: {f}" for f in tool_failures[:5]]
    if not any(store.coverage.get(t, {}).get("calls") for t in LOG_TOOLS):
        out.append("Logs were not searched.")
    if store.log_lines == 0 and not store.by_kind("log_pattern", "log"):
        out.append("No log lines of any level were received from the services in question in the window.")
    without = [s for s in scope if s not in store.metric_services]
    if scope and without:
        out.append(f"No metric samples exist in the window for: {', '.join(without)}.")
    elif not scope and not store.metric_services:
        out.append("No metric samples were retrieved.")
    traces = store.coverage.get("get_traces")
    if not traces:
        out.append("Traces were not examined.")
    elif not store.by_kind("trace"):
        out.append("The trace store returned no traces for the window (none recorded, or no trace store is connected).")
    if not store.coverage.get("list_deployments", {}).get("calls") and not store.coverage.get("get_deployment_context", {}).get("calls"):
        out.append("Deployment history was not examined.")
    return out


def observations(store: EvidenceStore, signals: list[Signal]) -> list[Fact]:
    """What is worth telling an engineer although it is not evidence of a fault."""
    out = [Fact(statement=f"Noticed, but not evidence of a fault on its own: {s.text}.", evidence_refs=s.evidence_refs) for s in signals if s.level == "weak"][:4]
    for d in sorted(store.by_kind("deployment"), key=lambda d: d.occurred_at or "", reverse=True)[:1]:
        out.append(Fact(statement=f"Most recent deployment on record: {d.title}, at {d.occurred_at}.", evidence_refs=[d.ref]))
    return out


def assess(store: EvidenceStore, hypotheses: list[HypothesisOut], scope: list[str], tool_failures: list[str]) -> Assessment:
    signals = find_signals(store, scope)
    strong = [s for s in signals if s.level == "strong"]
    moderate = [s for s in signals if s.level == "moderate"]
    missing = missing_telemetry(store, scope, tool_failures)
    logs_queried = any(store.coverage.get(t, {}).get("calls") for t in LOG_TOOLS) and not any(f.split(":")[0] in LOG_TOOLS for f in tool_failures)
    # A query that returns nothing proves nothing about a service that sends nothing. Logs count
    # as examined only when the service is known to have logged in the window.
    logs_present = bool(store.log_lines) or bool(store.by_kind("log_pattern", "log"))
    logs_examined = logs_queried and logs_present
    metrics_examined = bool(store.metric_services)
    top = hypotheses[0] if hypotheses else None
    kinds = {e.ref: e.kind for e in store.items}
    explained = bool(top and top.confidence >= SUPPORTED_HYPOTHESIS and any(kinds.get(r) in CAUSAL_KINDS for r in top.evidence_refs))

    def refs(items: list[Signal]) -> list[str]:
        return list(dict.fromkeys(r for s in items for r in s.evidence_refs))[:8]

    if strong:
        kinds = {s.kind for s in strong}
        confidence = min(0.9, 0.75 + 0.07 * len(kinds))
        seen = "; ".join(s.text for s in strong[:3])
        if explained:
            return Assessment(outcome="INCIDENT", confidence=round(confidence, 2), supporting_refs=refs(strong), signals=signals[:10], missing_telemetry=missing,
                              rationale=f"A failure is evident ({seen}) and at least one explanation is supported by evidence.")
        return Assessment(outcome="DEGRADED", confidence=round(confidence, 2), supporting_refs=refs(strong), signals=signals[:10], missing_telemetry=missing,
                          rationale=f"A failure is evident ({seen}), but the available evidence does not establish what caused it.")
    if moderate:
        confidence = min(0.7, 0.45 + 0.08 * len(moderate))
        return Assessment(outcome="DEGRADED", confidence=round(confidence, 2), supporting_refs=refs(moderate), signals=signals[:10], missing_telemetry=missing,
                          rationale="There are measurable anomalies (" + "; ".join(s.text for s in moderate[:3]) + "), but nothing that amounts to a clear failure, and no cause is established.")
    if not logs_examined and not metrics_examined:
        return Assessment(outcome="UNDETERMINED", confidence=0.0, signals=signals[:10], missing_telemetry=missing,
                          rationale="No telemetry could be examined for the services in question"
                          + (": they sent no metric samples and no log lines in the window" if logs_queried else "")
                          + ", so neither a fault nor good health can be concluded.")

    # ── HEALTHY: say what the conclusion rests on, and let coverage set the confidence ──
    steady = [e for e in store.by_kind("metric_baseline") if not scope or e.service in scope]
    healthy_status = [e for e in store.by_kind("service_health") if (e.data or {}).get("health") == "HEALTHY" and (not scope or e.service in scope)]
    confidence = 0.35
    basis: list[str] = []
    support: list[str] = []
    if steady:
        covered = {e.service for e in steady}
        confidence += 0.25 if not scope or covered >= set(scope) else 0.12
        basis.append("metrics held steady against the preceding window")
        support += [e.ref for e in steady]
    if logs_examined:
        confidence += 0.15
        basis.append("no error pattern of any size appeared in the logs" if not store.by_kind("log_pattern") else "the logs contain no error pattern of material size")
    if healthy_status:
        confidence += 0.1
        basis.append("the service catalogue records it as healthy with no alert firing")
        support += [e.ref for e in healthy_status]
    confidence -= min(0.3, 0.15 * len(tool_failures))
    confidence -= min(0.1, 0.03 * len([s for s in signals if s.level == "weak"]))
    if not metrics_examined:
        basis.append("no metrics were available, so this rests on logs alone")
    elif not logs_present:
        basis.append("no log lines were received in the window, so this rests on metrics")
    return Assessment(
        outcome="HEALTHY", confidence=round(max(0.15, min(0.9, confidence)), 2), supporting_refs=list(dict.fromkeys(support))[:8], signals=signals[:10], missing_telemetry=missing,
        rationale="No material evidence of a fault in the window examined: " + "; ".join(basis) + ".",
    )
