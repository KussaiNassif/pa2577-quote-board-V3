const express = require('express');

const PORT = process.env.PORT || 3001;
const QUOTES_API_URL = process.env.QUOTES_API_URL || 'http://localhost:3000';
// The browser origin allowed to call this API (quotes-api's page). Either a
// full origin, or ":<port>" = any host, but only quotes-api's port - the
// node IP differs per cluster, the port does not.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:3000';

function originAllowed(origin) {
  if (!origin) return false;
  if (!ALLOWED_ORIGIN.startsWith(':')) return origin === ALLOWED_ORIGIN;
  try { return new URL(origin).port === ALLOWED_ORIGIN.slice(1); } catch { return false; }
}
const PAGE_SIZE = 500;
const MAX_PAGES = 200;          // hard stop: at most 100 000 quotes per request
const UPSTREAM_TIMEOUT_MS = 3000;
// Each pod keeps its last result, tagged with the quote count it was built
// from. quotes-api can only ADD quotes (no edit/delete endpoint), so an
// unchanged count means unchanged data and the full recompute can be skipped.
let cache = { count: -1, stats: null };

const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'to', 'of', 'and', 'in', 'it', 'that', 'i', 'you']);

const app = express();

// The browser calls this service from a different origin (quotes-api's
// NodePort), so it needs CORS - restricted by ALLOWED_ORIGIN, not '*'.
app.use((req, res, next) => {
  if (originAllowed(req.headers.origin)) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  res.setHeader('Vary', 'Origin');
  next();
});

// No dependencies checked on purpose: stats-api holds no state, so if it
// answers at all it is alive and ready. A quotes-api outage is reported
// per request (502/504), not by restarting this service.
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

// Pages through ALL quotes via quotes-api's REST API. order=asc means new
// quotes are only appended at the end, so paging never skips or repeats one.
async function fetchAllQuotes() {
  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${QUOTES_API_URL}/api/quotes?order=asc&limit=${PAGE_SIZE}&skip=${page * PAGE_SIZE}`;
    const upstream = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (!upstream.ok) throw new Error(`quotes-api returned ${upstream.status}`);
    const batch = await upstream.json();
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return all;
}

function computeStats(quotes) {
  const wordCounts = {};
  const quotesPerAuthor = {};
  let totalLength = 0;

  for (const q of quotes) {
    totalLength += q.text.length;
    quotesPerAuthor[q.author] = (quotesPerAuthor[q.author] || 0) + 1;
    for (const rawWord of q.text.toLowerCase().split(/[^a-z0-9']+/)) {
      if (!rawWord || STOPWORDS.has(rawWord)) continue;
      wordCounts[rawWord] = (wordCounts[rawWord] || 0) + 1;
    }
  }

  const topWords = Object.entries(wordCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word, count]) => ({ word, count }));

  return {
    totalQuotes: quotes.length,
    averageLength: quotes.length ? Math.round(totalLength / quotes.length) : 0,
    topWords,
    quotesPerAuthor
  };
}

app.get('/api/stats', async (req, res) => {
  let quotes;
  try {
    // Cheap check first: one tiny request that only reads X-Total-Count.
    const head = await fetch(`${QUOTES_API_URL}/api/quotes?limit=1`, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (!head.ok) throw new Error(`quotes-api returned ${head.status}`);
    const count = Number(head.headers.get('X-Total-Count'));
    if (cache.stats && count === cache.count) {
      res.set('X-Cache', 'HIT');
      return res.json(cache.stats);
    }
    quotes = await fetchAllQuotes();
  } catch (err) {
    // 504: quotes-api never answered in time. 502: it answered, but with an error.
    const timedOut = err.name === 'TimeoutError';
    console.error(`could not reach quotes-api: ${err.message}`);
    return res.status(timedOut ? 504 : 502).json({ error: `quotes-api ${timedOut ? 'timed out' : 'unavailable'}` });
  }
  cache = { count: quotes.length, stats: computeStats(quotes) };
  console.log(`stats computed over ${quotes.length} quotes fetched from quotes-api`);
  res.set('X-Cache', 'MISS');
  res.json(cache.stats);
});

app.listen(PORT, () => console.log(`stats-api listening on ${PORT}, quotes-api=${QUOTES_API_URL}, allowed origin=${ALLOWED_ORIGIN}`));
