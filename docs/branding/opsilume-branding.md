# OPSILUME branding

OPSILUME is the working name of the product that was developed as OpsPilot. This document says what the name means, how the product is described, where the name is used, and where the old name is kept on purpose.

**Status of the name: a selected working name, not yet cleared.** No trademark search, trademark registration or domain registration has been done. Nothing in this repository should be read as a claim that the name is legally available. See [Clearance still required](#clearance-still-required).

## Name

**OPSILUME**, written in capitals.

- **OPS**: engineering and operational systems.
- **ILUME**: from *illuminate*: making complex operational problems understandable.

## Positioning

| | |
|---|---|
| Name | OPSILUME |
| Category | Engineering Intelligence Platform |
| Tagline | Illuminate every incident. |
| Short description | An AI-powered engineering operations and incident investigation platform that connects operational signals, discovers probable causes and guides evidence-backed resolution. |

Long description:

> OPSILUME is an AI-powered engineering operations and incident investigation platform that correlates logs, metrics, traces, deployments, GitHub changes, service dependencies and historical incidents to identify probable root causes, produce evidence-backed investigations and guide engineers towards safe remediation.

How the product is described matters as much as the name. Three rules follow from how it works:

- **Probable causes, not root causes.** OPSILUME ranks hypotheses with evidence and confidence. A human confirms a root cause. Do not write "finds the root cause".
- **Proposes, never performs.** Remediation is proposed and carried out only after human approval. Do not write "auto-remediation" or "self-healing".
- **No readiness claims.** The product runs locally and has been validated on synthetic scenarios and a local demonstration environment. Do not describe it as production-ready.

## Product capabilities and module names

Use these names in the interface and in documentation. They map onto the existing modules; no module was renamed in code.

| Capability | In the interface | Code (unchanged) |
|---|---|---|
| Incident Management | Incidents | `apps/api/src/modules/incidents.ts` |
| Service Management | Services | `modules/services.ts` |
| Observability | Monitoring | `modules/monitoring.ts`, trace retrieval in `integrations/traces.ts` |
| Log Management and Analysis | Logs | `modules/logs.ts` |
| Deployment Intelligence | Deployments | `modules/services.ts`, `modules/tools.ts` (`deployment-context`) |
| GitHub Integration | Changes | `modules/github.ts` |
| AI Incident Investigation | Investigations | `modules/investigations.ts`, `services/ai/app/graph.py` |
| Evidence Intelligence | Evidence, assessment and checked figures inside an investigation | `services/ai/app/evidence.py`, `assessment.py`, `claims.py` |
| Engineering Knowledge Base | Knowledge | `modules/knowledge.ts` |
| Human-approved Remediation | Approvals | `modules/remediation.ts` |
| Monitoring and Service Health | Monitoring, service health | `modules/monitoring.ts` |
| Analytics and Reporting | Analytics | `modules/analytics.ts` |

Conventions:

- The product name is always **OPSILUME**, never "Opsilume" or "OpsiLume".
- The assistant that writes investigations is **OPSILUME AI**. Reports always say which engine produced them (a named model, the mock, or the rule-based engine); the brand name never replaces that label.
- Capability names are written in title case in headings and in sentence case in running text ("deployment intelligence").

## Where the name is used

Changed to OPSILUME in this milestone:

- The web interface: wordmark, page titles and metadata, sign-in page (with category and tagline), and every sentence that names the product.
- Text the API shows to people: the actor labels "OPSILUME AI", "OPSILUME worker" and "OPSILUME monitoring" in the audit trail and incident timelines, and messages such as "OPSILUME did not change any external system".
- README title and introduction, and documentation written from this milestone on (`demo/README.md`, this document, the reliability documentation).
- The brand values live in one place for the interface: `apps/web/src/lib/brand.ts`.

## Identifiers that intentionally keep the old name

Renaming these would break existing installations, links, credentials or history, and brings no benefit to a user. They stay as they are until a rename is separately decided and planned.

| Identifier | Value | Why it stays |
|---|---|---|
| GitHub repository and URL | `msg-1/opspilot` | Renaming a public repository was not authorised; links and clones depend on it |
| npm packages | `opspilot`, `@opspilot/api`, `@opspilot/web` | Workspace names used in scripts, CI and lockfiles |
| Python package | `opspilot-ai` | Same |
| Docker Compose project, images, containers | `opspilot`, `opspilot-api-1`, … | Volumes and running stacks are keyed by the project name |
| Database, role and volume | `opspilot`, `opspilot_test`, `pgdata` | Existing data |
| API paths | `/api/v1/...` | Unchanged; they never contained the name |
| HTTP headers | `X-OpsPilot-Signature`, `X-OpsPilot-Attempt`, `User-Agent: opspilot` | Webhook receivers verify and match on these |
| Cookie names, JWT issuer, queue names | as they are | Changing them signs every user out or orphans queued jobs |
| Environment variables | `OPSPILOT_API_KEY`, `OPSPILOT_API_URL`, `OPSPILOT_WRITE_CONTRACT` and others | Deployment configuration |
| MCP server name and tool prefix | `opspilot` | Client configurations refer to it |
| Demo password | `OpsPilot-demo-1` | A credential in existing seeds and tests |
| File and directory names | `apps/web/e2e/opspilot.spec.ts`, memory and CI names | No user sees them |
| Code comments and log lines | "OpsPilot" in older comments and in `OpsPilot API listening` | Historical; changed when the surrounding code is next touched |
| Git history, changelog entries and earlier documents | "OpsPilot" | They record what was true when written |

Older documents (`docs/architecture.md`, `docs/engineering-audit.md` and others) still say OpsPilot in their body. They describe the same product; each now needs no change to remain correct, and is updated to the new name when it is next revised.

## Clearance still required

Before OPSILUME is used as anything more than a working name:

1. **Trademark search** in the classes for software and software services (Nice classes 9 and 42) in every jurisdiction where the product would be offered, including similar-sounding and similar-looking marks.
2. **Trademark application**, if the search is clear and the owner decides to proceed.
3. **Domain names**: availability and registration of the chosen domains. None has been registered or configured.
4. **Company, product and social-media name checks** for existing use of the same or a confusingly similar name.
5. **Repository and package rename plan**, if wanted: GitHub redirects, package names, Compose project and database names, header names with a period in which both are accepted.
6. **Legal review** of the description and tagline as marketing claims.

Until then: the name appears in the product and its documentation as a working name; no release is published under it; no domain is pointed at it.
