# API documentation

Base URL: `http://localhost:4000/api/v1`. JSON in and out.

## Conventions

- **Authentication:** session cookie (set by `/auth/login`), `Authorization: Bearer <access token>`, or `x-api-key: opk_...`.
- **Errors:** `{ "error": { "code": "validation_error", "message": "...", "details": [{ "path": "title", "message": "..." }] } }` with status 400, 401, 403, 404, 409, 413, 422, 429, 500 or 503.
- **Lists:** `?page=1&pageSize=25` → `{ "data": [...], "meta": { "page", "pageSize", "total", "totalPages" } }`.
- **Time parameters** (`from`, `to`): ISO-8601, or relative such as `15m`, `6h`, `7d` meaning "that long ago".
- **Services** can be referenced by id or slug wherever a `service` parameter appears.

## Roles and permissions

| Capability | Viewer | Engineer | Admin | Owner |
|---|:-:|:-:|:-:|:-:|
| Read everything except audit log and API keys | ✓ | ✓ | ✓ | ✓ |
| Manage incidents, services, deployments, knowledge, alert rules | | ✓ | ✓ | ✓ |
| Run investigations, propose and execute remediation | | ✓ | ✓ | ✓ |
| Approve low and medium risk remediation | | ✓ | ✓ | ✓ |
| Approve high-risk remediation | | | ✓ | ✓ |
| Members, teams, integrations, API keys, settings, audit log | | | ✓ | ✓ |

API key scopes: `ingest:logs`, `ingest:deployments`, `ingest:events`, `ingest:metrics`, `tools:read`.

## Endpoints

### Auth — `/auth`
| Method and path | Description |
|---|---|
| `POST /register` | Create an organisation and its owner. Body: `email`, `password` (10+ characters, letter and number), `name`, `organizationName` |
| `POST /login` | Body: `email`, `password`, optional `organizationId` |
| `POST /refresh` | Rotate the refresh token, issue a new access token |
| `POST /logout` | Revoke the session |
| `GET /me` | User, organisation, role, permissions, other organisations |
| `POST /switch-organization` | Body: `organizationId` |
| `PATCH /profile` | `name`, `title`, or `currentPassword` + `newPassword` |
| `GET /invitations/:token`, `POST /accept-invitation` | Invitation preview and acceptance |

### Incidents — `/incidents`
| Method and path | Description |
|---|---|
| `GET /` | Filters: `q`, `status`, `severity`, `service`, `assigneeId`, `active=true|false`, `from`, `to`, `sort` |
| `POST /` | `title`, `severity` (SEV1–SEV4), `serviceIds[]`, `description`, `assigneeId`, `commanderId`, `customerImpact`, `startedAt` |
| `GET /:id` | By id or key (`INC-12`). Includes timeline, investigations, remediation, alerts, postmortem |
| `PATCH /:id` | Any of the create fields plus `status`, `rootCause`, `resolution`, `note`. Closing requires `RESOLVED` first |
| `POST /:id/comments` | `message`; `@Full Name` notifies that member |
| `GET /:id/context` | Related deployments, service events, alerts, error patterns, similar incidents |
| `POST /:id/postmortem` | Create a postmortem draft in the knowledge base (idempotent) |

### Services, deployments, events
| Method and path | Description |
|---|---|
| `GET/POST /services`, `GET/PATCH/DELETE /services/:id` | Catalogue. `GET /services/graph` returns nodes and edges |
| `PUT /services/:id/dependencies` | Replace upstream dependencies: `{ dependencies: [{ serviceId, kind }] }` |
| `GET/POST /deployments`, `GET/PATCH /deployments/:id` | Record and browse deployments. Detail includes the linked commit, pull requests, previous deployment and incidents that began within 6 hours |
| `GET/POST /service-events` | Config changes, feature flags, scaling, restarts, maintenance |

### Logs — `/logs`
| Method and path | Description |
|---|---|
| `POST /` | `{ service?, environment?, logs: [{ timestamp?, level?, message, service?, host?, traceId?, spanId?, attributes? }] }`, up to 5,000 per request. Returns `{ accepted, unknownServices }` |
| `GET /` | Filters: `q`, `service`, `level`, `environment`, `traceId`, `fingerprint`, `from` (default `1h`), `to`, `order` |
| `GET /histogram`, `/patterns`, `/anomalies`, `/facets` | Volume by level over time; lines grouped by pattern; patterns that are new or at least 3× their baseline rate; filter values |

### Monitoring — `/monitoring`
| Method and path | Description |
|---|---|
| `POST /metrics` | `{ samples: [{ service, metric, value, timestamp? }] }`. Metric names are `lower_snake_case` |
| `GET /overview` | Health, latest values, error-rate sparkline and firing alerts per service |
| `GET /series?service=&metric=a,b&from=` | Bucketed avg/min/max |
| `GET/POST /alert-rules`, `PATCH/DELETE /alert-rules/:id` | `service`, `name`, `metric`, `comparator` (`gt`/`lt`), `threshold`, `windowMinutes`, `severity`, `autoIncident` |
| `GET /alerts`, `POST /evaluate` | Alert history; evaluate rules now (also runs every minute) |

### GitHub — `/github`, `/webhooks/github`
| Method and path | Description |
|---|---|
| `GET/PUT /github/integration` | Status; set `token` and/or `webhookSecret` (`null` removes) |
| `GET/POST /github/repositories`, `PATCH/DELETE /github/repositories/:id` | `fullName` (`owner/name`), `service`, `sample` |
| `POST /github/sync` | Queue a sync of all or one repository |
| `GET /github/commits`, `/github/pull-requests` | Filters: `repository`, `service`, `q`, `from`, `to`, `state` |
| `POST /webhooks/github/:orgSlug` | GitHub webhook receiver (`push`, `pull_request`, `ping`); requires a valid `X-Hub-Signature-256` |

### Knowledge — `/knowledge`
| Method and path | Description |
|---|---|
| `GET/POST /documents`, `GET/PATCH/DELETE /documents/:id` | `title`, `type`, `content` (Markdown), `service`, `tags`, `sourceUrl` |
| `POST /documents/:id/reindex`, `POST /reindex` | Re-embed one or all documents |
| `POST /search` | `{ query, limit?, types?, service? }` → `{ mode: "hybrid"|"keyword", note?, hits: [...] }` |

### Investigations — `/investigations`
| Method and path | Description |
|---|---|
| `POST /` | `{ question, incidentId?, timeWindow?: { from, to } }` → 202 with the queued investigation |
| `GET /`, `GET /:id` | List; detail with plan, steps, evidence, hypotheses, report and proposed remediation |
| `POST /:id/cancel` | Cancel a queued or running investigation |
| `GET /ai-status` | Which analysis engine and embedding model are active |

### Remediation — `/remediations`
| Method and path | Description |
|---|---|
| `GET /`, `POST /`, `GET /:id` | `type`, `title`, `description`, `rationale`, `risk`, `incidentId`, `serviceId`, `parameters` |
| `POST /:id/request-approval` | `PROPOSED` → `PENDING_APPROVAL` |
| `POST /:id/approve`, `/reject` | Signed-in users only. `comment` optional for approve, required for reject |
| `POST /:id/execute` | `APPROVED` only. Without a webhook configured, requires `{ confirmManual: true, notes? }` |
| `POST /:id/retry`, `/cancel` | Return a failed action to `APPROVED`; cancel before execution |

### Organisation and governance
| Method and path | Description |
|---|---|
| `GET /members`, `POST /members/invitations`, `PATCH/DELETE /members/:id` | Membership and roles |
| `GET/POST /teams`, `PATCH/DELETE /teams/:id`, `PUT/DELETE /teams/:id/members/:userId` | Teams, leads and on-call flags |
| `GET/PATCH /settings` | Approval policy, log retention and redaction, remediation webhook |
| `GET/POST /api-keys`, `DELETE /api-keys/:id` | The secret is returned once, on creation |
| `GET /audit-logs` | Filters: `action` (prefix), `actorType`, `resourceType`, `resourceId`, `from`, `to`; `format=csv` |
| `GET /notifications`, `POST /notifications/read` | In-app notifications |
| `GET /analytics/overview?from=30d`, `GET /analytics/incidents.csv` | Reliability and delivery measures; CSV export |
| `GET /dashboard`, `GET /system/status` | Overview aggregate; database, Redis, queues and AI status |

### Tool API — `/tools` (agent, MCP)
Read-only and compact. Accepts a user session, an API key with `tools:read`, or the investigation's tool token.

`GET /services`, `/services/:ref`, `/incidents`, `/incidents/:id/context`, `/logs/search`, `/logs/patterns`, `/logs/anomalies`, `/logs/histogram`, `/deployments`, `/code-changes`, `/service-events`, `/metrics`; `POST /knowledge/search`.

## AI service (internal)

Called only by the API with the `x-internal-token` header: `GET /v1/status`, `POST /v1/embeddings`, `POST /v1/investigations/run` (NDJSON events: `meta`, `step`, `evidence`, `final`, `error`).
