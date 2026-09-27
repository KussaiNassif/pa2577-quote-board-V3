# Quote Board — PA2577 "Build Something"

This file is deliverable items 1–3 (description, architecture, discussion)
and 4 (repository). Deployment instructions are in "How to deploy" at the
bottom; the video outline is in §5.

---

## 1. Description of the software

**Quote Board** is a small two-service application for collecting and
analysing short text quotes, deliberately built as an extension of the
QuoteFinder application studied earlier in this course (the assignment
brief explicitly allows reusing an existing idea).

- A user opens a web page, types in a quote and an author, and submits it.
- The page immediately shows the full list of quotes.
- The page also shows live statistics about the quote collection: total
  count, average length, the 10 most frequent words (stopwords excluded),
  and a per-author breakdown.

The quotes and the stats are deliberately computed by **two separate
microservices that never share a database** — the point of the exercise is
not the quote board itself (which is intentionally trivial) but demonstrating
a correctly-decomposed, independently-scalable, Kubernetes-deployed
microservice architecture around it.

**Acknowledgement (per the assignment's own allowance):** this application
is too small to genuinely *need* horizontal scaling or a real multi-node
cluster. To make the architecture make sense, pretend: (a) quote submission
is bursty and high-volume (e.g. a live event where thousands of viewers
submit reactions at once), and (b) the statistics computation is expensive
enough (e.g. real NLP instead of a word-frequency count) that it must run on
separate, independently-scaled hardware from the write path. Under that
pretense, splitting "accept writes" from "compute derived analytics" into
two independently-scalable services is a real, defensible design — see
also the "Big Data is Dead" discussion in Quiz 1/2: most workloads don't
actually need this, and part of the exercise is knowing when they don't.

## 2. Software architecture design

### Components and responsibilities

| Component | Type | Responsibility | REST API |
|---|---|---|---|
| **quotes-api** | Microservice A (stateful-backed) | Owns the MongoDB database exclusively. Accepts new quotes, lists quotes, serves the browser frontend (static HTML/JS) and a small runtime-config endpoint. | `GET/POST /api/quotes`, `GET /api/quotes/:id`, `GET /healthz` |
| **stats-api** | Microservice B (stateless) | Has **no** database access. Calls `quotes-api`'s REST API to fetch all quotes, then computes word-frequency and per-author statistics in memory. | `GET /api/stats`, `GET /healthz` |
| **mongo** | Database | Persists quotes. Single instance, not scaled (per assignment allowance). PVC-backed storage. | none (internal only, not a microservice) |
| **Browser** | Client, outside the cluster | Loads `quotes-api`'s static page, then makes REST calls to *both* `quotes-api` (read/write quotes) and `stats-api` (read stats) directly. | consumer |

### Architecture principles / cloud patterns applied

This maps directly onto the pattern catalogues studied in Quiz 2
(Taibi et al. 2018; Wilder 2012):

- **Database-per-Service** (Taibi et al.) — `quotes-api` is the *only*
  service that ever talks to MongoDB. This is a direct, deliberate fix for
  the exact weakness identified in QuoteFinder V2, where both `app` and
  every `worker` connected straight to the shared Mongo instance (the
  weaker "Shared Database Server" pattern). Here, `stats-api` gets its data
  the correct way: over REST, from the service that owns it.
- **Single Service per Host / service-instance-per-container** (Taibi et al.)
  — each of the three components (`quotes-api`, `stats-api`, `mongo`) is its
  own container image, its own Kubernetes Deployment, and scales
  independently.
- **Horizontally Scaling Compute** (Wilder) — `quotes-api` and `stats-api`
  are both stateless HTTP services (no server-side session, no socket.io —
  a deliberate lesson taken from QuoteFinder V2's frontend-scaling problem)
  so either can be scaled with a plain `kubectl scale deployment/<name>
  --replicas=N` with zero coordination needed between them.
- **REST between services, not a message queue** — the same conclusion
  as the course's QuoteFinder: Version 2 used a Redis queue (RSMQ) with
  return queues, which made the containers depend on each other and needed
  socket.io back to the browser; Version 3 replaced it with REST calls to
  the workers. `stats-api` → `quotes-api` is that Version 3 pattern: a
  plain HTTP request that any replica behind the Service can answer.
- **No sticky sessions needed** — QuoteFinder's frontend needed
  `sessionAffinity: ClientIP` because socket.io tied a browser to one pod.
  Quote Board uses only stateless request/response REST, so every
  request can go to any replica and no session affinity is required.
- **No API-Gateway** — the browser talks to both services' NodePorts
  directly rather than through a single gateway. This is a conscious
  simplification (see Challenges below), not an oversight.
- **REST as the sole inter-service contract** — `stats-api` never imports
  `quotes-api`'s code or schema; it only knows one HTTP endpoint contract.
  This is what lets the two services be written, deployed, versioned, and
  scaled completely independently — the "physical isolation" and "ease of
  deployment" principles from Taibi et al. §3.4.

### Component → microservice mapping (Kubernetes objects)

```
quotes-api  → Deployment (2 replicas) + ConfigMap + Service (NodePort 30080)
stats-api   → Deployment (2 replicas) + ConfigMap + Service (NodePort 30081)
mongo       → StatefulSet (1 replica, volumeClaimTemplates → PVC 1Gi, readiness probe) + Secret + Service (ClusterIP)
```

Two ConfigMaps carry the *same* variable name (`STATS_API_URL` /
`QUOTES_API_URL`) but with **different values for different vantage
points** — `quotes-api-config`'s `STATS_API_URL` is the browser-facing
NodePort address, while `stats-api-config`'s `QUOTES_API_URL` is the
in-cluster Service DNS name (`http://quotes-api:3000`). This distinction
— "what address is *this* caller actually located at" — is worth being
able to explain clearly in the video/defense.

Secrets (Mongo root credentials) are separated from ConfigMaps and injected
via `secretKeyRef`, matching the Quiz 2 answer on ConfigMap vs Secret: this
is data that would be a real incident if leaked in plaintext, non-sensitive
config is not.

### External access

`quotes-api`'s Service is `type: NodePort`, reachable from a browser at
`http://<node-ip>:30080` — this is what makes the application "accessible
from outside Kubernetes" as the assignment requires. `stats-api` is
*also* exposed as NodePort (`30081`), not because a human needs to browse
to it directly, but because the browser's client-side JavaScript calls it
directly too (see architecture diagram below) — and because it lets a
grader independently `curl` each microservice's REST API on its own,
without going through the other one.

### Request flow

```
                    ┌─────────────┐
                    │   Browser   │  (outside the cluster)
                    └──────┬──────┘
             ┌─────────────┴─────────────┐
             │ GET /  GET/POST /api/...  │ GET /api/stats
             ▼                            ▼
   ┌───────────────────┐        ┌───────────────────┐
   │  quotes-api        │        │  stats-api         │
   │  NodePort :30080   │        │  NodePort :30081   │
   │  (2 replicas)       │        │  (2 replicas)       │
   └─────────┬───────────┘        └─────────┬───────────┘
             │ mongodb://                   │ GET http://quotes-api:3000/api/quotes
             ▼                              │ (in-cluster REST call)
   ┌───────────────────┐                    │
   │  mongo              │◄───────(no direct access from stats-api)
   │  ClusterIP, PVC     │
   │  (1 replica)         │
   └───────────────────┘
```

## 3. Benefits and challenges

### Benefits

- **Independent scaling and deployment.** `quotes-api` and `stats-api` can
  be scaled, redeployed, or rolled back with zero coordination — a burst of
  quote submissions doesn't require touching `stats-api` at all, and vice
  versa.
- **Clear ownership boundary.** Only one service can ever corrupt or
  mismanage the quote data, which makes reasoning about data integrity and
  debugging much simpler than the QuoteFinder V2 shared-database design.
- **Technology independence.** `stats-api` could be rewritten in Python
  tomorrow without `quotes-api` even being aware, since the only contract
  between them is a REST JSON response.
- **Resilience isolation.** If `stats-api` crashes or is slow, quote
  submission and browsing keep working — the frontend degrades gracefully
  (see `app.js`'s try/catch around the stats fetch).

### Challenges — and what was done / can be done about them

- **No API Gateway → the browser must know two separate addresses.**
  Today this is hardcoded via a `ConfigMap`-injected `STATS_API_URL`. At
  real scale this doesn't hold up (every NodePort is a new thing clients
  must track, and NodePort numbers aren't stable across clusters). *Fix:*
  introduce a single Ingress (or a real API-Gateway pattern) in front of
  both services, so the browser only ever talks to one hostname/path
  prefix and internal service topology can change freely.
- **`mongo` is a single point of failure and a bottleneck** — this was a
  deliberate simplification (the assignment explicitly says the database
  need not scale), but it means both services' availability is capped by
  one Mongo pod. *Mitigation path:* a MongoDB replica set (Taibi et al.'s
  "Database Cluster" pattern) instead of one instance — same lesson
  identified for QuoteFinder V2 in Quiz 2.
- **No autoscaling.** Replica counts are fixed in the Deployment YAML;
  nothing reacts to load automatically. *Mitigation path:* a
  HorizontalPodAutoscaler keyed on CPU or request rate — left out here to
  keep the deployment legible for the video walkthrough, but the manifests
  are structured (readiness/liveness probes, resource requests/limits
  already set) so adding an HPA is a small, additive step.
- **Scaling `stats-api` does not scale its dependencies.** Every stats
  computation pages through *all* quotes via `quotes-api`'s REST API
  (`?order=asc&limit=500&skip=N`), so 20 `stats-api` pods with many users
  would push the load down the chain: stats-api → quotes-api → MongoDB.
  Replicas distribute *requests*, they do not make one computation faster.
  *What was done:* each `stats-api` pod caches its last result, tagged with
  the quote count. A request first asks `quotes-api` for the count only
  (`limit=1`, `X-Total-Count` header); if it is unchanged, the cached result
  is returned. This is valid because the API can only *add* quotes. *What
  can be done next:* precompute statistics on write, or let the database
  aggregate — the same "linear data analysis" problem as in the Big Data
  part of the course.
- **Failure isolation is explicit.** If MongoDB is down, `quotes-api`
  answers `503` instead of crashing, and its *readiness* probe fails so
  Kubernetes stops routing traffic to it. Its *liveness* probe (`/livez`)
  deliberately does not check MongoDB — restarting `quotes-api` cannot fix a
  database outage. `stats-api` answers `502` if `quotes-api` returns an
  error and `504` if it does not answer within 3 s, and the page shows
  which service failed. Note that the page itself is served by
  `quotes-api`, so if *every* `quotes-api` pod is down there is no UI.
- **Persistence has limits.** The PVC keeps data across pod restarts and
  cluster stop/start, but only within the cluster's storage backend.
  Deleting the cluster (`kind delete cluster`) or the PVC deletes the data. A
  PVC is not a backup; production needs backups/replication.

### Security discussion

- **No authentication or authorization on any REST endpoint.** Anyone who
  can reach the NodePorts can read and write quotes, and read stats. This
  is the single biggest gap in this build, kept out deliberately to keep
  the demo legible for the assignment's scope — a production version would
  put an auth layer (e.g. JWT validated at an API Gateway, so individual
  services don't each reimplement auth) in front of the write path at
  minimum.
- **Secrets are base64, not encrypted, by default.** The Mongo root
  credentials live in a Kubernetes `Secret`, which is *encoded*, not
  *encrypted*, unless etcd encryption-at-rest is separately enabled on the
  cluster (same point made in the Quiz 2 answer on ConfigMap vs Secret).
  *What was done:* the Secret is **not in the repository**. It is created
  at deploy time with a random password (see "How to deploy"), and for
  local development the password is read from a gitignored `.env` file.
  The database connection string is never logged — only host and database
  name are.
  Mitigation: enable etcd encryption at rest, or use an external secret
  store (e.g. Vault, or a cloud provider's secret manager) instead of
  native `Secret` objects for anything beyond a course demo.
- **Network exposure is minimised where it costs nothing.** `mongo`'s
  Service is `ClusterIP` only — it is *not* reachable from outside the
  cluster, and only `quotes-api` ever holds credentials for it. `stats-api`
  has no credentials, but note that it *can* still open a network
  connection to `mongo:27017` — nothing blocks pod-to-pod traffic inside
  the cluster. *Mitigation:* a NetworkPolicy allowing ingress to `mongo`
  only from `quotes-api` pods (requires a CNI that enforces policies, e.g.
  Calico; not every local cluster's default network enforces them).
- **CORS is restricted by port, not `*`.** The browser calls `stats-api`
  directly, so it must send CORS headers. `ALLOWED_ORIGIN: ":30080"` in the
  ConfigMap allows any origin on quotes-api's port, so the same config works
  on any node IP. Tested: `http://localhost:30080` is allowed,
  `http://localhost:9999` and `https://malicious-site.example` are blocked.
  *Limitation:* the check compares only the port, so a page on a different
  host that also uses port 30080 (e.g. `http://malicious-site.example:30080`)
  is allowed too. *Fix:* set `ALLOWED_ORIGIN` to the exact origin
  (e.g. `http://localhost:30080`), which the code already supports. Note that
  CORS only stops *browsers* from reading the response; the stats are not
  secret, and `curl` can always read them.
- **Containers run as a non-root user.** Both Dockerfiles create and
  switch to an unprivileged `app` user before `CMD`, rather than running as
  root inside the container — a small but standard hardening step.
- **No TLS.** All traffic (browser↔service and service↔service) is plain
  HTTP. Acceptable for a local/course demo; in any real deployment this
  needs TLS termination, most simply at an Ingress controller so individual
  services don't each need certificate management.
- **Input handling.** `quotes-api` validates that `text`/`author`
  are non-empty strings (so a JSON object such as `{"$gt": ""}` is rejected
  with `400`), enforces length limits (`400`) and a 10 kB body limit
  (`413`), and uses Mongoose schema-typed writes rather than raw queries.
  Invalid input can no longer crash the service: all route errors go
  through one error handler. The frontend escapes all user-supplied text
  before inserting it into the DOM (`escapeHtml` in `app.js`), which is the
  relevant defence against stored XSS given quotes are user-submitted text
  rendered back to other users.
- **Resource limits are set on every container** (`resources.limits` in
  each Deployment), which bounds how much a single compromised or
  misbehaving pod can consume — a basic defence against one pod starving
  the node it's scheduled on.

## 4. Configuration management repository

Repository: https://github.com/KussaiNassif/pa2577-quote-board-V3

## 5. Video outline (5–10 min)

1. What the project is (30s) — the Quote Board idea, and the honest
   acknowledgement that it's intentionally small (see §1).
2. Walk through `quotes-api` and `stats-api`'s responsibilities and how
   they talk over REST (2 min) — use the request-flow diagram above.
3. Run it (see "How to deploy"), then `kubectl get pods -n quoteboard`
   showing replicas coming up (2 min).
4. Open the browser at the NodePort URL, add a quote, show the stats panel
   update (1 min).
5. Show logs: `kubectl logs -n quoteboard deploy/stats-api` while
   submitting a quote, to show the live REST call to `quotes-api` (1 min).
6. Scale one service independently:
   `kubectl scale deployment/stats-api -n quoteboard --replicas=4` and show
   it not touching `quotes-api` (1 min).
7. Briefly walk through one or two YAML files — recommend
   `21-quotes-api-deployment.yaml` (env from ConfigMap+Secret, probes) and
   `13-mongo-service.yaml` (ClusterIP-only) (1–2 min).
8. Mention the security gaps and what you'd fix (30s–1 min) — pulls
   straight from §3 above.

## How to deploy

Requires a Kubernetes cluster and `kubectl`. Tested on **kind** (Kubernetes
in Docker), whose cluster definition is part of this repository
(`kind-cluster.yaml`, it maps the two NodePorts to localhost). The images
are on Docker Hub, so nothing needs to be built.

0. Create the cluster: `kind create cluster --name quoteboard --config kind-cluster.yaml`

No IP addresses need to be configured: the browser derives stats-api's
address from the page's own host (see `STATS_API_URL: ":30081"`).

1. Create the namespace and the database Secret (random password, never
   stored in the repository):
   ```
   kubectl apply -f k8s/00-namespace.yaml
   kubectl -n quoteboard create secret generic mongo-credentials \
     --from-literal=username=root \
     --from-literal=password="$(head -c 18 /dev/urandom | base64)"
   ```
2. Deploy everything: `kubectl apply -f k8s/`
3. Open `http://localhost:30080` in a browser.

Note: MongoDB sets its root password only the first time it initialises
its volume. If you recreate the Secret with a new password while the PVC
still exists, delete the PVC too (this deletes the data).
