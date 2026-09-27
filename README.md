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
| **quotes-api** | Microservice A (stateful-backed) | Owns the MongoDB database exclusively. Accepts new quotes, lists quotes, serves the browser frontend (static HTML/JS), and is the browser's single entry point: it forwards `GET /api/stats` to `stats-api` inside the cluster. | `GET/POST /api/quotes`, `GET /api/quotes/:id`, `GET /api/stats` (forwarded), `GET /healthz`, `GET /livez` |
| **stats-api** | Microservice B (stateless) | Has **no** database access. Calls `quotes-api`'s REST API to fetch all quotes, then computes word-frequency and per-author statistics in memory. | `GET /api/stats`, `GET /healthz` |
| **mongo** | Database | Persists quotes. Single instance, not scaled (per assignment allowance). PVC-backed storage. | none (internal only, not a microservice) |
| **Browser** | Client, outside the cluster | Loads `quotes-api`'s static page and makes all REST calls to that same origin: quotes directly, stats through `quotes-api`'s forwarding. | consumer |

### Architecture principles / cloud patterns applied

This maps directly onto the pattern catalogues studied in Quiz 2
(Taibi et al. 2018; Wilder 2012):

- **Database-per-Service** (Taibi et al.) — `quotes-api` is the *only*
  service that ever talks to MongoDB. This is a direct, deliberate fix for
  the exact weakness identified in QuoteFinder V2, where both `app` and
  every `worker` connected straight to the shared Mongo instance (the
  weaker "Shared Database Server" pattern). Here, `stats-api` gets its data
  the correct way: over REST, from the service that owns it.
- **Service instance per container** (Taibi et al., a sub-variant of
  *Single Service per Host*) — each of the three components (`quotes-api`,
  `stats-api`, `mongo`) is its own container image and its own Kubernetes
  workload: the two APIs are Deployments that scale independently, and
  `mongo` is a single-replica StatefulSet (not scaled, per the assignment's
  allowance). *Note:* the local kind cluster has a single node, so at the
  machine level all pods share one host (*Multiple Service per Host*); on a
  multi-node cluster the scheduler would spread them.
- **Server-side Discovery** (Taibi et al.) — `stats-api` calls the stable
  name `http://quotes-api:3000`; Kubernetes DNS resolves it to the Service,
  and the Service load-balances to a ready replica. The caller never keeps a
  list of instances (that would be *Client-side Discovery*). The same
  holds the other way: `quotes-api` forwards stats to `http://stats-api:3001`.
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
- **Single entry point (a minimal API-Gateway, Taibi et al.)** — the
  browser only talks to `quotes-api` (one NodePort, one origin).
  `quotes-api` forwards `/api/stats` to `stats-api` over REST inside the
  cluster. This removes the need for CORS and makes the app work behind
  any NodePort, tunnel or proxy (e.g. `minikube service`). It is a
  deliberately small gateway: no auth, TLS or rate limiting yet (see
  Challenges).
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

The two ConfigMaps mirror each other: `quotes-api-config`'s
`STATS_API_URL` (`http://stats-api:3001`) and `stats-api-config`'s
`QUOTES_API_URL` (`http://quotes-api:3000`) are both **in-cluster Service
DNS names**. Each service finds the other by name, never by IP, so one
`kubectl apply -f k8s/` works without any address being filled in.

Secrets (Mongo root credentials) are separated from ConfigMaps and injected
via `secretKeyRef`, matching the Quiz 2 answer on ConfigMap vs Secret: this
is data that would be a real incident if leaked in plaintext, non-sensitive
config is not.

### External access

`quotes-api`'s Service is `type: NodePort`, reachable from a browser at
`http://<node-ip>:30080` — this is what makes the application "accessible
from outside Kubernetes" as the assignment requires, and it is the only
address the browser needs. `stats-api` is *also* exposed as NodePort
(`30081`), not for the browser, but so that a grader can `curl` each
microservice's REST API on its own, without going through the other one.

### Data model

Only one kind of data is persisted, and only one service owns it.

```
MongoDB  database "quotes"  →  collection "quotes"   (owner: quotes-api ONLY)
┌──────────────────────────────────────────────────────────────────────┐
│ Quote document (Mongoose schema in quotes-api/server.js)             │
│   _id        ObjectId  auto; contains the creation time, so sorting  │
│                        on _id = sorting by insertion order           │
│   text       String    required, trimmed, max 500 chars              │
│   author     String    required, trimmed, max 120 chars              │
│   createdAt  Date      default: now                                  │
│   __v        Number    Mongoose version key (automatic)              │
└──────────────────────────────────────────────────────────────────────┘
  stored on PVC "mongo-data-mongo-0" (1Gi) → survives pod and cluster restarts

Derived data, NOT persisted (owner: stats-api, in memory, one copy per pod)
┌──────────────────────────────────────────────────────────────────────┐
│ Stats (response of GET /api/stats)                                   │
│   totalQuotes      Number                                            │
│   averageLength    Number   (characters, rounded)                    │
│   topWords         [{ word: String, count: Number }]  top 10,        │
│                    English stopwords excluded                        │
│   quotesPerAuthor  { <author>: Number }                              │
│ Cache: { count, stats }  reused while X-Total-Count is unchanged     │
└──────────────────────────────────────────────────────────────────────┘

Configuration data (Kubernetes objects, not application data)
  Secret    mongo-credentials   username, password → mongo + quotes-api only
  ConfigMap quotes-api-config   MONGO_HOST, MONGO_DB, STATS_API_URL (in-cluster)
  ConfigMap stats-api-config    QUOTES_API_URL (in-cluster)
```

### Data flow diagram

Processes are the two microservices, data stores are MongoDB and
stats-api's in-memory cache, and the only external entity is the user's
browser. The dashed line is the cluster boundary: the browser crosses it
at exactly one place, `quotes-api`'s NodePort.

```
 EXTERNAL ENTITY   ┆                 KUBERNETES CLUSTER (namespace quoteboard)
 ┌─────────────┐   ┆
 │  Browser    │   ┆ (1) POST /api/quotes {text,author}
 │ (user, runs │───┆─────────────────────►┌──────────────────────┐ (2) insert    ╔═════════════╗
 │  app.js)    │◄──┆──────────────────────│ P1  quotes-api       │──────────────►║ D1 MongoDB  ║
 │             │   ┆ (3) 201 + quote      │ NodePort :30080      │               ║ "quotes"    ║
 │             │───┆─ (4) GET /api/quotes►│ owns the data,       │◄──────────────║ on PVC      ║
 │             │◄──┆── list, newest first─│ single entry point   │ (9) find,     ╚═════════════╝
 │             │   ┆                      │                      │ sort _id, countDocuments
 │             │───┆─ (5) GET /api/stats ►│  forwards ──┐        │
 │             │◄──┆─ (12) stats JSON ────│  ◄──────┐   │        │
 └─────────────┘   ┆   (same origin,      └─────────┼───┼────────┘
                   ┆    no CORS)             (11)   │   │ (6) GET http://stats-api:3001/api/stats
                   ┆                       stats    │   ▼     (REST, in-cluster)
                   ┆                      ┌─────────┴────────────┐ (8) count     ┌──────────────┐
                   ┆                      │ P2  stats-api        │ unchanged? ──►│ D2  cache    │
                   ┆  curl only ─────────►│ NodePort :30081      │◄──────────────│ {count,stats}│
                   ┆  (grading)           │ NO database access   │  HIT → reuse  │ per pod, RAM │
                   ┆                      └──────────┬───────────┘               └──────────────┘
                   ┆                                 │ (7) GET http://quotes-api:3000/api/quotes?limit=1
                   ┆                                 │ (10) on a miss: ?order=asc&limit=500&skip=N
                   ┆                                 └──────────► back to P1 (REST, in-cluster)
```

| # | Flow | Data | Notes |
|---|---|---|---|
| 1 | Browser → quotes-api | `{text, author}` JSON, max 10 kB | rejected with 400 unless both are non-empty strings |
| 2 | quotes-api → MongoDB | Quote document | the only write path in the system |
| 3 | quotes-api → Browser | saved quote, `201` | |
| 4 | Browser → quotes-api → Browser | list of quotes (default newest first) | rendered through `escapeHtml` |
| 5 | Browser → quotes-api | `GET /api/stats` | same origin as the page, so no CORS |
| 6 | quotes-api → stats-api | `GET http://stats-api:3001/api/stats` | in-cluster; 10 s timeout |
| 7 | stats-api → quotes-api | `GET /api/quotes?limit=1` | reads only the `X-Total-Count` header |
| 8 | stats-api ↔ its cache | `{count, stats}` | same count → answer from cache (`X-Cache: HIT`) |
| 9 | quotes-api → MongoDB | `find().sort({_id}).skip().limit()`, `countDocuments()` | |
| 10 | stats-api → quotes-api | pages of 500, `order=asc` | only on a cache miss; max 200 pages |
| 11 | stats-api → quotes-api | stats JSON (+ `X-Cache`) | `502`/`504` if stats-api's own upstream failed |
| 12 | quotes-api → Browser | stats JSON | `502` if stats-api is unreachable, `504` if it timed out |

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
  (see `app.js`'s try/catch around the stats fetch). Tested with `stats-api`
  scaled to 0: quote requests kept answering `200`, `/api/stats` answered
  `502`, and the page showed "Stats unavailable: 502 stats-api unavailable".

### Challenges — and what was done / can be done about them

- **The single entry point is minimal, and quotes-api carries it.**
  *Done:* the browser only knows one address, and `quotes-api` forwards
  stats requests inside the cluster (an earlier version had the browser
  call two NodePorts, which broke behind tunnels and needed CORS). *Cost:*
  `quotes-api` is now on the path of every browser request, so if it is
  down the stats page is down too (it already served the page). *Next
  step:* a real Ingress / API-Gateway in front of both services, where
  TLS, authentication and rate limiting can live in one place.
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
- **No cross-origin access at all.** The browser only calls its own
  origin, so neither service sends CORS headers: no other website can read
  these APIs from a visitor's browser. (An earlier version let the browser
  call `stats-api` directly and allowed CORS by port, which also let any
  site on port 30080 in; routing stats through `quotes-api` removed that
  gap.) CORS never stopped non-browser clients: `curl` can read the stats
  NodePort, which is fine because the stats are not secret.
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
   they talk over REST (2 min) — use the data flow diagram in §2.
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
(`kussainassif/quotes-api:1.0.1`, `kussainassif/stats-api:1.0.1`) are on
Docker Hub, so nothing needs to be built.

0. Create the cluster: `kind create cluster --name quoteboard --config kind-cluster.yaml`

No IP addresses need to be configured: the services find each other by
Service name, and the browser only uses the page's own origin. On other
clusters (not tested here), any way of reaching port 3000 of the
`quotes-api` Service works, including `minikube service quotes-api`.

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
