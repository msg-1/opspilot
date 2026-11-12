# Database design

PostgreSQL 16 with the `vector` and `pg_trgm` extensions. The schema is defined in `apps/api/prisma/schema.prisma`; migrations are in `apps/api/prisma/migrations`.

## Principles

- **Tenant key on every table.** Tenant-owned tables carry `organizationId`; child tables reach it through their parent. Deleting an organisation cascades to all of its data.
- **Ids are cuids** (strings). Incidents also have a human number, unique per organisation (`INC-12`), allocated by incrementing `Organization.incidentCounter` inside the transaction that creates the incident.
- **Enums for closed sets** that drive logic (roles, severities, statuses). Free strings for open sets that integrations extend (event types, evidence kinds, metric names).
- **Timestamps in UTC**; `createdAt` is set by the database.

## Tables by area

| Area | Tables | Notes |
|---|---|---|
| Identity | `User`, `Organization`, `Membership`, `Invitation`, `RefreshToken`, `ApiKey`, `OrganizationSettings` | A user can belong to several organisations with different roles. Tokens and keys are stored as hashes. |
| Teams and services | `Team`, `TeamMember`, `Service`, `ServiceDependency` | Dependencies are directed edges (`serviceId` depends on `dependsOnId`). Slugs are unique per organisation. |
| Change history | `Deployment`, `ServiceEvent`, `Repository`, `Commit`, `PullRequest`, `GithubIntegration` | Deployments link to commits by SHA prefix. A rollback points at the deployment it reverts. |
| Incidents | `Incident`, `IncidentService`, `IncidentEvent` | `IncidentEvent` is the append-only timeline (status changes, comments, AI and remediation activity). |
| Telemetry | `LogEntry`, `MetricSample`, `AlertRule`, `Alert` | `LogEntry.fingerprint` is a hash of the message with variable parts removed; it groups lines into patterns. |
| Knowledge | `KnowledgeDocument`, `KnowledgeChunk` | `KnowledgeChunk.embedding` is `vector(768)`. |
| Investigations | `Investigation`, `InvestigationStep`, `Evidence`, `Hypothesis` | `Evidence.ref` (E1…) is unique per investigation; hypotheses store the refs they cite. |
| Remediation | `RemediationAction`, `Approval` | One approval per approver per action. |
| Governance | `AuditLog`, `Notification` | Audit entries are only ever inserted. |

## Indexes worth knowing

| Index | Purpose |
|---|---|
| `LogEntry (organizationId, timestamp DESC)` and variants with `serviceId`, `level`, `fingerprint` | Time-window scans for search, histograms and pattern grouping |
| `LogEntry.message` GIN with `gin_trgm_ops` | Substring search (`ILIKE '%text%'`) without a sequential scan |
| `KnowledgeChunk.embedding` HNSW with `vector_cosine_ops` | Approximate nearest-neighbour retrieval |
| `MetricSample (organizationId, serviceId, metric, timestamp DESC)` | Series and "latest value" queries |
| `Incident (organizationId, number)` unique | Per-organisation numbering |
| `AuditLog (organizationId, createdAt DESC)` | Audit browsing and export |

The HNSW index is created by hand-written SQL in the initial migration because Prisma cannot express it. See the migration rule in `CLAUDE.md` before generating a new migration.

## Raw SQL

Prisma is used for almost everything. Raw SQL is used where the ORM has no equivalent: time bucketing for histograms and metric series, pattern grouping, `DISTINCT ON` for latest metric values, trigram similarity for similar incidents, and all vector reads and writes. All of it is parameterised through Prisma's tagged templates.

## Retention

An hourly job deletes `LogEntry` and `MetricSample` rows older than the organisation's `logRetentionDays` (default 30) and expired refresh tokens. Incidents, investigations, approvals and audit entries are kept indefinitely.

## Scaling notes

Logs and metrics live in ordinary tables, which is right for a local or small-team deployment. Past tens of millions of rows the next steps are time-based partitioning of `LogEntry` and `MetricSample`, then moving them to a store built for that workload behind the same query functions (`searchLogs`, `logPatterns`, `metricSeries`).
