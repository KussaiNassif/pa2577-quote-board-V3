async function loadQuotes() {
  const el = document.getElementById('quotes');
  const res = await fetch('/api/quotes').catch(() => null);
  if (!res || !res.ok) {
    el.innerHTML = `<p style="color:#b00">quotes-api unavailable (${res ? res.status : 'no response'})</p>`;
    return;
  }
  const quotes = await res.json();
  el.innerHTML = quotes.length
    ? quotes.map(q => `<div class="quote">"${escapeHtml(q.text)}"<br><small>— ${escapeHtml(q.author)}</small></div>`).join('')
    : '<p>No quotes yet.</p>';
}

async function loadStats() {
  const el = document.getElementById('stats');
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`${res.status} ${body.error || 'stats-api error'}`);
    }
    const stats = await res.json();
    el.innerHTML = `
      <p>Total quotes: <strong>${stats.totalQuotes}</strong></p>
      <p>Average length: <strong>${stats.averageLength}</strong> chars</p>
      <p>Top words: ${stats.topWords.map(w => `${escapeHtml(w.word)} (${w.count})`).join(', ') || '—'}</p>
      <p>Quotes per author: ${Object.entries(stats.quotesPerAuthor).map(([a, c]) => `${escapeHtml(a)}: ${c}`).join(', ') || '—'}</p>
    `;
  } catch (err) {
    el.innerHTML = `<p style="color:#b00">Stats unavailable: ${escapeHtml(err.message)}</p>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.getElementById('quote-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = document.getElementById('text').value;
  const author = document.getElementById('author').value;
  const status = document.getElementById('form-status');
  let res;
  try {
    res = await fetch('/api/quotes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, author })
    });
  } catch (err) {
    status.textContent = `Could not reach quotes-api: ${err.message}`;
    return;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    status.textContent = `Not saved (${res.status}): ${body.error || 'unknown error'}`;
    return;
  }
  status.textContent = '';
  e.target.reset();
  await loadQuotes();
  await loadStats();
});

loadQuotes();
loadStats();
