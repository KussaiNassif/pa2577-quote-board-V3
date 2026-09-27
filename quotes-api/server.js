const express = require('express');
const mongoose = require('mongoose');
const path = require('path');

const PORT = process.env.PORT || 3000;
const STATS_API_URL = process.env.STATS_API_URL || 'http://localhost:3001';
const MAX_PAGE_SIZE = 500;

const MONGO_HOST = process.env.MONGO_HOST || 'localhost:27017';
const MONGO_DB = process.env.MONGO_DB || 'quotes';

// MONGO_URL wins if set (handy for local dev); otherwise build it from
// discrete parts, which is what the k8s Secret + ConfigMap supply.
// NEVER log this string - it contains the database password.
const MONGO_URL = process.env.MONGO_URL || (() => {
  const user = process.env.MONGO_USER;
  const pass = process.env.MONGO_PASS;
  const auth = user && pass ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : '';
  return `mongodb://${auth}${MONGO_HOST}/${MONGO_DB}${user ? '?authSource=admin' : ''}`;
})();

const quoteSchema = new mongoose.Schema({
  text: { type: String, required: true, trim: true, maxlength: 500 },
  author: { type: String, required: true, trim: true, maxlength: 120 },
  createdAt: { type: Date, default: Date.now }
});
const Quote = mongoose.model('Quote', quoteSchema);

const dbConnected = () => mongoose.connection.readyState === 1;

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Injects the externally reachable stats-api URL into the browser at runtime,
// so the frontend doesn't need to be rebuilt when the ConfigMap value changes.
app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`window.STATS_API_URL = ${JSON.stringify(STATS_API_URL)};`);
});

// Liveness: "is this process alive?" Deliberately does NOT check Mongo -
// if the database is down, restarting quotes-api would not fix anything.
app.get('/livez', (req, res) => res.json({ status: 'alive' }));

// Readiness: "can this pod serve requests right now?" Fails while Mongo is
// unreachable, so Kubernetes stops routing traffic here until it recovers.
app.get('/healthz', (req, res) => {
  const ok = dbConnected();
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'db-disconnected' });
});

// Fail fast with 503 instead of letting queries queue up while Mongo is down.
app.use('/api', (req, res, next) => {
  if (!dbConnected()) return res.status(503).json({ error: 'database unavailable' });
  next();
});

// Express 4 does not catch errors thrown in async handlers - without this
// wrapper, one failed database call would crash the whole process.
const route = (fn) => (req, res, next) => fn(req, res).catch(next);

// GET /api/quotes?limit=N&skip=M&order=asc|desc
// Newest first by default (what the page shows). stats-api pages through
// everything with order=asc, so new quotes only ever append to the end.
app.get('/api/quotes', route(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || MAX_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
  const order = req.query.order === 'asc' ? 1 : -1;
  const quotes = await Quote.find().sort({ _id: order }).skip(skip).limit(limit);
  res.set('X-Total-Count', String(await Quote.countDocuments()));
  res.json(quotes);
}));

app.post('/api/quotes', route(async (req, res) => {
  const { text, author } = req.body || {};
  if (typeof text !== 'string' || typeof author !== 'string' || !text.trim() || !author.trim()) {
    return res.status(400).json({ error: 'text and author are required strings' });
  }
  const quote = await Quote.create({ text, author });
  res.status(201).json(quote);
}));

app.get('/api/quotes/:id', route(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'not found' });
  const quote = await Quote.findById(req.params.id);
  if (!quote) return res.status(404).json({ error: 'not found' });
  res.json(quote);
}));

// Central error handler: bad input -> 400, anything else -> 503.
// Logs the error message only, never the connection string.
app.use((err, req, res, next) => {
  if (err instanceof mongoose.Error.ValidationError || err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid quote' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'request too large' });
  }
  console.error(`request failed: ${req.method} ${req.path}: ${err.message}`);
  res.status(503).json({ error: 'service unavailable' });
});

// Start serving at once and keep retrying the database in the background.
// Until Mongo answers, /livez is 200 (the process is fine) but /healthz is
// 503, so Kubernetes keeps the pod out of the Service instead of restarting
// it. Exiting here instead would put the pod in CrashLoopBackOff, whose
// growing restart delay (up to 5 min) outlasts a slow database start.
async function connectWithRetry() {
  for (;;) {
    try {
      await mongoose.connect(MONGO_URL);
      console.log(`mongo connected (host=${MONGO_HOST} db=${MONGO_DB})`);
      return;
    } catch (err) {
      console.error(`mongo not reachable (${err.message}), retrying in 3 s`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

mongoose.connection.on('disconnected', () => console.warn('mongo disconnected'));
mongoose.connection.on('reconnected', () => console.log('mongo reconnected'));

app.listen(PORT, () => console.log(`quotes-api listening on ${PORT}`));
connectWithRetry();
