"""Turns raw tool results into citable evidence items (E1, E2, …).

Extraction is deterministic: an evidence item exists only if a tool actually returned the
underlying record, and it keeps that record's id. The model can cite evidence but cannot create it.
"""

from __future__ import annotations

from typing import Any

from .schemas import EvidenceItem

NOTABLE_METRIC_CHANGE = 25.0  # percent


def _clip(text: Any, n: int = 220) -> str:
    s = " ".join(str(text or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


class EvidenceStore:
    def __init__(self, limit: int = 60):
        self.items: list[EvidenceItem] = []
        self._seen: dict[tuple[str, str], EvidenceItem] = {}
        self._limit = limit
        #: What was looked at, whether or not it produced evidence: {tool: {"calls", "records"}}.
        #: "Nothing found" and "never checked" are different things for a health conclusion.
        self.coverage: dict[str, dict[str, int]] = {}
        #: Services for which metric samples were returned
        self.metric_services: set[str] = set()

    def add(self, kind: str, title: str, summary: str, *, source_type: str, source_id: str, occurred_at: str | None = None,
            service: str | None = None, relevance: float | None = None, data: dict[str, Any] | None = None) -> EvidenceItem | None:
        key = (source_type, str(source_id))
        if key in self._seen:
            return self._seen[key]
        if len(self.items) >= self._limit:
            return None
        item = EvidenceItem(
            ref=f"E{len(self.items) + 1}", kind=kind, title=_clip(title, 160), summary=_clip(summary, 600),
            source_type=source_type, source_id=str(source_id), occurred_at=occurred_at, service=service, relevance=relevance, data=data,
        )
        self.items.append(item)
        self._seen[key] = item
        return item

    def by_kind(self, *kinds: str) -> list[EvidenceItem]:
        return [e for e in self.items if e.kind in kinds]

    def refs(self) -> set[str]:
        return {e.ref for e in self.items}

    # ── extraction per tool ──

    def ingest(self, tool: str, result: dict[str, Any]) -> list[EvidenceItem]:
        """Returns the evidence items (new or previously known) that this result supports."""
        before = len(self.items)
        touched: list[EvidenceItem | None] = []
        handler = getattr(self, f"_from_{tool}", None)
        if handler:
            touched = handler(result)
        seen_before = self.coverage.setdefault(tool, {"calls": 0, "records": 0})
        seen_before["calls"] += 1
        seen_before["records"] += sum(len(v) for v in result.values() if isinstance(v, list))
        seen: set[str] = set()
        out: list[EvidenceItem] = []
        for item in touched:
            if item and item.ref not in seen:
                seen.add(item.ref)
                out.append(item)
        self.new_since_last = self.items[before:]
        return out

    def _pattern(self, p: dict[str, Any], *, anomaly: bool) -> EvidenceItem | None:
        service = p.get("serviceSlug") or p.get("serviceName") or "unknown service"
        count = p.get("count", 0)
        if anomaly:
            tag = "new pattern" if p.get("kind") == "new" else f"{p.get('ratio')}x above baseline"
            title = f"{count}× {p.get('level')} in {service} ({tag})"
        else:
            title = f"{count}× {p.get('level')} in {service}"
        return self.add(
            "log_pattern", title,
            f"\"{_clip(p.get('sample'), 260)}\" — first seen {p.get('firstSeen')}, last seen {p.get('lastSeen')}"
            + (f"; baseline count {p.get('baselineCount')}" if anomaly else ""),
            source_type="log_pattern", source_id=f"{p.get('fingerprint')}:{p.get('serviceId')}", occurred_at=p.get("firstSeen"), service=service,
            data={k: p.get(k) for k in ("fingerprint", "count", "level", "firstSeen", "lastSeen", "kind", "ratio", "baselineCount", "sample", "serviceId")},
        )

    def _from_find_log_anomalies(self, r: dict[str, Any]) -> list[EvidenceItem | None]:
        return [self._pattern(p, anomaly=True) for p in r.get("anomalies", [])[:12]]

    def _from_get_log_patterns(self, r: dict[str, Any]) -> list[EvidenceItem | None]:
        return [self._pattern(p, anomaly=False) for p in r.get("patterns", [])[:10]]

    def _from_search_logs(self, r: dict[str, Any]) -> list[EvidenceItem | None]:
        out = []
        for log in r.get("logs", [])[:8]:
            if log.get("level") not in ("WARN", "ERROR", "FATAL"):
                continue
            out.append(self.add(
                "log", f"{log.get('level')} log from {log.get('service') or 'unknown'}", _clip(log.get("message"), 400),
                source_type="log", source_id=log["id"], occurred_at=log.get("timestamp"), service=log.get("service"),
                data={"traceId": log.get("traceId"), "attributes": log.get("attributes"), "fingerprint": log.get("fingerprint")},
            ))
        return out

    def _deployment(self, d: dict[str, Any]) -> EvidenceItem | None:
        label = "Rollback" if d.get("isRollback") else "Deployment"
        return self.add(
            "deployment", f"{label} of {d.get('service')} {d.get('version')} ({str(d.get('status', '')).lower()})",
            f"{d.get('description') or 'No description'} — by {d.get('deployedBy') or 'unknown'}, commit {str(d.get('commitSha') or 'n/a')[:12]}, "
            f"environment {d.get('environment', 'production')}",
            source_type="deployment", source_id=d["id"], occurred_at=d.get("startedAt"), service=d.get("service"),
            data={k: d.get(k) for k in ("version", "status", "commitSha", "environment", "deployedBy", "isRollback", "startedAt")},
        )

    def _from_list_deployments(self, r: dict[str, Any]) -> list[EvidenceItem | None]:
        return [self._deployment(d) for d in r.get("deployments", [])[:12]]

    def _event(self, e: dict[str, Any]) -> EvidenceItem | None:
        return self.add(
            "service_event", f"{str(e.get('type', 'event')).replace('_', ' ')} on {e.get('service')}: {e.get('title')}",
            f"{e.get('details') or e.get('title')} — by {e.get('actor') or 'unknown'}",
            source_type="service_event", source_id=e["id"], occurred_at=e.get("occurredAt"), service=e.get("service"), data={"type": e.get("type")},
        )

    def _from_list_service_events(self, r: dict[str, Any]) -> list[EvidenceItem | None]:
        return [self._event(e) for e in r.get("events", [])[:12]]

    def _from_get_code_changes(self, r: dict[str, Any]) -> list[EvidenceItem | None]:
        out = []
        for p in r.get("pullRequests", [])[:8]:
            sample = " (sample data)" if p.get("sampleData") else ""
            out.append(self.add(
                "pull_request", f"PR #{p.get('number')} in {p.get('repository')}: {p.get('title')}{sample}",
                f"{_clip(p.get('body'), 420) or 'No description'} — by {p.get('author')}, merged {p.get('mergedAt')}",
                source_type="pull_request", source_id=p["id"], occurred_at=p.get("mergedAt"), service=p.get("service"),
                data={"number": p.get("number"), "mergeCommitSha": p.get("mergeCommitSha"), "labels": p.get("labels"), "sampleData": p.get("sampleData"), "body": p.get("body"), "title": p.get("title")},
            ))
        for c in r.get("commits", [])[:8]:
            sample = " (sample data)" if c.get("sampleData") else ""
            files = c.get("files") or []
            out.append(self.add(
                "commit", f"Commit {c.get('sha')} in {c.get('repository')}{sample}",
                f"{_clip(c.get('message'), 300)} — by {c.get('author')}; files: {', '.join(files[:8]) or 'not available'}",
                source_type="commit", source_id=c["id"], occurred_at=c.get("committedAt"), service=c.get("service"),
                data={"sha": c.get("sha"), "files": files, "message": c.get("message"), "sampleData": c.get("sampleData")},
            ))
        return out

    def _from_get_deployment_context(self, r: dict[str, Any]) -> list[EvidenceItem | None]:
        target = r.get("deployment")
        if not target:
            return []
        out: list[EvidenceItem | None] = [self._deployment(target)]
        previous = r.get("previousSuccessful")
        if previous:
            out.append(self._deployment(previous))
        errors = r.get("errorLogs") or {}
        before, after = errors.get("beforePerMinute"), errors.get("afterPerMinute")
        if after is not None and before is not None and (errors.get("before") or errors.get("after")):
            if before == 0:
                change = "none before" if after else "none either side"
            else:
                change = f"{after / before:.1f}x the rate before"
            out.append(self.add(
                "deployment_impact", f"Error logs around {target.get('service')} {target.get('version')}: {errors.get('after')} after vs {errors.get('before')} before",
                f"{errors.get('after')} ERROR/FATAL log lines in the {errors.get('windowMinutes')} minutes after the deployment ({after}/min) against "
                f"{errors.get('before')} in the 30 minutes before ({before}/min): {change}."
                + (f" Replaced {previous.get('version')}, deployed {previous.get('startedAt')}." if previous else " No earlier successful deployment is recorded.")
                + (" This deployment has already been rolled back." if r.get("alreadyRolledBack") else ""),
                source_type="deployment_impact", source_id=target["id"], occurred_at=target.get("startedAt"), service=target.get("service"),
                data={"errorLogs": errors, "rollbackTarget": r.get("rollbackTarget"), "alreadyRolledBack": r.get("alreadyRolledBack"), "minutesSinceDeployment": r.get("minutesSinceDeployment")},
            ))
        out += self._from_get_code_changes(r.get("changes") or {})
        return out

    def _from_get_metrics(self, r: dict[str, Any]) -> list[EvidenceItem | None]:
        out = []
        service = r.get("service")
        steady: list[dict[str, Any]] = []
        window_from = None
        for m in r.get("metrics", []):
            change = m.get("changePercent")
            window = m.get("window") or {}
            if not window.get("samples"):
                continue
            self.metric_services.add(str(service))
            window_from = window_from or window.get("from")
            base = m.get("baseline") or {}
            unit = m.get("unit") or ""
            if change is None or abs(change) < NOTABLE_METRIC_CHANGE:
                steady.append({"metric": m.get("metric"), "label": m.get("label"), "unit": unit, "avg": window.get("avg"), "max": window.get("max"), "baselineAvg": base.get("avg"), "changePercent": change})
                continue
            direction = "up" if change > 0 else "down"
            out.append(self.add(
                "metric", f"{m.get('label')} for {service} {direction} {abs(change):.0f}%",
                f"{m.get('metric')} averaged {_num(window.get('avg'))}{unit} (max {_num(window.get('max'))}{unit}) between {window.get('from')} and {window.get('to')}, "
                f"versus {_num(base.get('avg'))}{unit} in the preceding window",
                source_type="metric", source_id=f"{service}:{m.get('metric')}:{window.get('from')}", occurred_at=window.get("from"), service=service,
                data={"metric": m.get("metric"), "unit": unit, "changePercent": change, "avg": window.get("avg"), "max": window.get("max"), "min": window.get("min"), "baselineAvg": base.get("avg")},
            ))
        if steady:
            # Metrics that did NOT move are evidence too: they are what a healthy conclusion rests on.
            out.append(self.add(
                "metric_baseline", f"{len(steady)} metric(s) for {service} show no notable change",
                "; ".join(f"{m['metric']} averaged {_num(m['avg'])}{m['unit']}" + (f" ({_num(m['baselineAvg'])}{m['unit']} before)" if m["baselineAvg"] is not None else "") for m in steady[:8]),
                source_type="metric_baseline", source_id=f"{service}:{window_from}", occurred_at=window_from, service=service, data={"metrics": steady[:12]},
            ))
        return out

    def _from_get_traces(self, r: dict[str, Any]) -> list[EvidenceItem | None]:
        """Slow and failed traces, each with the span that accounts for most of the time."""
        out = []
        for t in r.get("traces", [])[:6]:
            slowest = t.get("slowestSpan") or {}
            failed = t.get("errorSpans") or []
            title = f"{'Failed' if failed else 'Slow'} trace through {t.get('rootService')}: {_num(t.get('durationMs'))}ms"
            parts = [f"{t.get('rootOperation')} took {_num(t.get('durationMs'))}ms across {t.get('spanCount')} spans in {', '.join(t.get('services') or [])}."]
            if slowest:
                parts.append(f"Most of the time was spent in {slowest.get('service')} {slowest.get('operation')} ({_num(slowest.get('durationMs'))}ms).")
            if failed:
                parts.append("Spans with errors: " + "; ".join(f"{e.get('service')} {e.get('operation')}" + (f" ({_clip(e.get('message'), 80)})" if e.get("message") else "") for e in failed[:3]) + ".")
            out.append(self.add(
                "trace", title, " ".join(parts), source_type="trace", source_id=str(t.get("traceId")), occurred_at=t.get("startedAt"), service=t.get("rootService"),
                data={k: t.get(k) for k in ("traceId", "durationMs", "spanCount", "services", "rootOperation", "slowestSpan", "errorSpans")},
            ))
        return out

    def _from_get_incident_context(self, r: dict[str, Any]) -> list[EvidenceItem | None]:
        out: list[EvidenceItem | None] = []
        for a in r.get("alerts", [])[:6]:
            out.append(self.add("alert", f"Alert on {a.get('service')} ({a.get('status')})", a.get("message", ""), source_type="alert", source_id=a["id"], occurred_at=a.get("startedAt"), service=a.get("service")))
        out += [self._deployment(d) for d in r.get("deployments", [])[:10]]
        out += [self._event(e) for e in r.get("serviceEvents", [])[:10]]
        out += [self._pattern(p, anomaly=False) for p in r.get("errorPatterns", [])[:8]]
        out += self._similar(r.get("similarIncidents", []))
        for d in r.get("upstreamDependencies", []):
            if d.get("health") in ("DEGRADED", "DOWN"):
                out.append(self.add("dependency", f"Upstream dependency {d.get('slug')} is {d.get('health')}", f"{d.get('name')} ({d.get('kind')} dependency) is currently {d.get('health')}", source_type="service", source_id=d["id"], service=d.get("slug")))
        return out

    def _similar(self, incidents: list[dict[str, Any]]) -> list[EvidenceItem | None]:
        out = []
        for i in incidents[:5]:
            if not (i.get("rootCause") or i.get("resolution")):
                continue
            out.append(self.add(
                "incident", f"Past incident {i.get('key')}: {i.get('title')}",
                f"Root cause: {i.get('rootCause') or 'not recorded'} Resolution: {i.get('resolution') or 'not recorded'}",
                source_type="incident", source_id=i["id"], occurred_at=i.get("startedAt"),
                data={"key": i.get("key"), "rootCause": i.get("rootCause"), "resolution": i.get("resolution"), "severity": i.get("severity")},
            ))
        return out

    def _from_search_incidents(self, r: dict[str, Any]) -> list[EvidenceItem | None]:
        return self._similar(r.get("incidents", []))

    def _from_search_knowledge_base(self, r: dict[str, Any]) -> list[EvidenceItem | None]:
        out = []
        for h in r.get("results", [])[:5]:
            section = str(h.get("section") or "").split(" › ")[-1]
            doc_title = str(h.get("title") or "Document")
            label = doc_title if not section or section == doc_title.split(": ")[-1] or section in doc_title else f"{doc_title} › {section}"
            out.append(self.add(
                "document", label, _clip(h.get("content"), 560),
                source_type="knowledge_chunk", source_id=h["chunkId"], relevance=h.get("similarity"),
                data={"documentId": h.get("documentId"), "content": h.get("content"), "matchedBy": h.get("matchedBy"), "docType": h.get("type")},
            ))
        return out

    def _from_get_service(self, r: dict[str, Any]) -> list[EvidenceItem | None]:
        out = []
        if r.get("health") and r.get("slug"):
            firing = r.get("firingAlerts") or []
            out.append(self.add(
                "service_health", f"{r.get('slug')} is recorded as {r.get('health')}",
                (r.get("healthNote") or f"Health status of {r.get('name') or r.get('slug')} in the service catalogue.") + (f" {len(firing)} alert(s) firing." if firing else " No alert is firing."),
                source_type="service_health", source_id=str(r.get("id") or r.get("slug")), service=r.get("slug"), data={"health": r.get("health"), "firingAlerts": len(firing)},
            ))
        for d in r.get("dependsOn", []):
            if d.get("health") in ("DEGRADED", "DOWN"):
                out.append(self.add("dependency", f"Upstream dependency {d.get('slug')} is {d.get('health')}", f"{r.get('slug')} depends on {d.get('name')} ({d.get('kind')}), which is {d.get('health')}: {d.get('healthNote') or ''}", source_type="service", source_id=f"dep:{d.get('slug')}", service=d.get("slug")))
        return out


def _num(v: Any) -> str:
    if v is None:
        return "n/a"
    return f"{v:.2f}".rstrip("0").rstrip(".") if isinstance(v, float) else str(v)
