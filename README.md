# Quote Board — PA2577 "Build Something"

**Quote Board** collects short quotes and shows live statistics (count, average length, top words, quotes per author). It extends the course's QuoteFinder.

## 1. Description & Business Case
**Scenario:** a live-event feedback board. The audience submits quotes from their phones, and venue screens show live statistics. The app itself is small: the scenario is what justifies the architecture (the assignment allows this).
- **Elasticity:** traffic is near zero most of the year and bursts during an event. In the cloud we add pods for the event and remove them afterwards, paying only for what runs.
- **Asymmetric scaling:** ingesting quotes (I/O) and analysing them (CPU, imagine real NLP instead of word counts) grow differently. Separate services scale, and are paid for, separately.
- **Resilience:** if `stats-api` fails, quotes can still be submitted. Only the statistics panel stops.
- **Portability vs. cost:** plain Kubernetes and public images run on any provider, which limits lock-in. At the app's *real* small, steady load, one VM or a PaaS would be cheaper, and Kubernetes pays off only under the bursty scenario.

## 2. Architecture
| Component | Responsibility |
|---|---|
| **gateway** (nginx) | Single entry point (NodePort 30080). Routes `/api/stats` to stats-api and everything else to quotes-api. No CORS needed. |
| **quotes-api** | REST API for quotes (`GET/POST /api/quotes`). The only service with database access. Serves the web page. ClusterIP. |
| **stats-api** | REST API `GET /api/stats`. No database access: fetches quotes from quotes-api over REST and caches the result until the count changes. ClusterIP. |
| **mongo** | StatefulSet with a 1Gi PVC, so data survives restarts. One instance (allowed). |
```
Browser ──► gateway :30080 ──/api/stats──► stats-api ──REST──► quotes-api ──► MongoDB (PVC)
                    └────────── everything else ─────────────────►┘
```
**Patterns:** API-Gateway, Database-per-Service and Server-side Discovery via Kubernetes DNS (Taibi et al. 2018). Horizontally Scaling Compute (Wilder): gateway, quotes-api and stats-api are stateless, each with 2 replicas, and scale independently. REST instead of queues (as in QuoteFinder V3).
**Why a separate gateway:** letting quotes-api forward stats would create a cycle (stats-api → quotes-api → stats-api). Cyclic dependency is a microservice anti-pattern, with an API-Gateway as the fix (Taibi, Lenarduzzi & Pahl, *Microservices Anti-Patterns: A Taxonomy*).

## 3. Benefits, challenges & security
- **Benefits:** independent scaling and deployment, one owner of the data, failures isolated (stats-api at 0 replicas → quotes `200`, stats `502`).
- **Gateway = single point of failure / bottleneck.** Mitigated with a stateless design, 2 replicas and health probes.
- **Single database instance.** *Next:* a MongoDB replica set. A PVC is not a backup.
- **No autoscaling.** *Next:* a HorizontalPodAutoscaler (resource requests and limits are already set).
- **Security:** no authentication or TLS yet (*next:* add both at the gateway, the one place all traffic passes). Only the gateway is reachable from outside. The Mongo Secret is created at deploy time and is not in git, but quotes-api uses the root account (*next:* a least-privilege user and a NetworkPolicy). Input is validated (`400`/`413`) and output is escaped against XSS. Services run as non-root, with resource limits.

## 4. Repository
https://github.com/KussaiNassif/pa2577-quote-board-V3

## 5. Video outline
Idea → architecture → deploy + `kubectl get pods` → browser demo → logs (`kubectl logs deploy/gateway`, `kubectl logs -l app=stats-api`) → `kubectl scale deploy/stats-api --replicas=4` → walk through `k8s/40-gateway.yaml` and `k8s/21-quotes-api-deployment.yaml` → challenges.

## How to deploy
Tested on kind. The images `kussainassif/quotes-api:1.0.1` and `stats-api:1.0.1` are on Docker Hub (amd64).
```
kind create cluster --name quoteboard --config kind-cluster.yaml
kubectl apply -f k8s/00-namespace.yaml
kubectl -n quoteboard create secret generic mongo-credentials \
  --from-literal=username=root --from-literal=password="$(head -c 18 /dev/urandom | base64)"
kubectl apply -f k8s/
```
Open `http://localhost:30080`. On other clusters, use `minikube service gateway -n quoteboard` or `kubectl -n quoteboard port-forward svc/gateway 8080:8080`.
