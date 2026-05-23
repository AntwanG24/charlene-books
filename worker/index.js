// Charlene Book List - Cloudflare Worker API

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function rowToBook(row) {
  return {
    id:        row.id,
    tab:       row.tab,
    title:     row.title,
    series:    row.series,
    author:    row.author,
    publisher: row.publisher,
    isbn13:    row.isbn13,
    pages:     row.pages,
    lexile:    row.lexile,
    foundAt:   row.found_at,
    readIn:    row.read_in,
    note:      row.note,
    status:    row.status,
    coverUrl:  row.cover_url,
    sortOrder: row.sort_order ?? row.id,
    addedAt:   row.added_at,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { method } = request;

    if (method === 'OPTIONS') return new Response(null, { headers: CORS });

    const path = url.pathname;

    // GET /api/books?tab=en|zh|pending
    if (method === 'GET' && path === '/api/books') {
      const tab = url.searchParams.get('tab');
      let stmt;
      if (tab && ['en','zh','pending'].includes(tab)) {
        stmt = env.DB.prepare('SELECT * FROM books WHERE tab = ? ORDER BY sort_order ASC, id ASC').bind(tab);
      } else {
        stmt = env.DB.prepare('SELECT * FROM books ORDER BY tab, sort_order ASC, id ASC');
      }
      const { results } = await stmt.all();
      return json(results.map(rowToBook));
    }

    // POST /api/books — create
    if (method === 'POST' && path === '/api/books') {
      const b = await request.json();
      // Get max sort_order for this tab
      const maxRow = await env.DB.prepare('SELECT MAX(sort_order) as m FROM books WHERE tab = ?').bind(b.tab || 'en').first();
      const nextOrder = (maxRow?.m ?? 0) + 1;
      const stmt = env.DB.prepare(`
        INSERT INTO books (tab, title, series, author, publisher, isbn13, pages, lexile, found_at, read_in, note, status, cover_url, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        b.tab || 'en', b.title || '', b.series || '', b.author || '',
        b.publisher || '', b.isbn13 || '', b.pages || '', b.lexile || '',
        b.foundAt || '', b.readIn || '', b.note || '', b.status || 'unread',
        b.coverUrl || '', b.sortOrder ?? nextOrder,
      );
      const result = await stmt.run();
      const row = await env.DB.prepare('SELECT * FROM books WHERE id = ?').bind(result.meta.last_row_id).first();
      return json(rowToBook(row), 201);
    }

    // PUT /api/books/:id — update
    const putMatch = path.match(/^\/api\/books\/(\d+)$/);
    if (method === 'PUT' && putMatch) {
      const id = parseInt(putMatch[1]);
      const b = await request.json();
      await env.DB.prepare(`
        UPDATE books SET
          tab = ?, title = ?, series = ?, author = ?, publisher = ?,
          isbn13 = ?, pages = ?, lexile = ?, found_at = ?, read_in = ?,
          note = ?, status = ?, cover_url = ?, sort_order = ?
        WHERE id = ?
      `).bind(
        b.tab, b.title, b.series || '', b.author || '', b.publisher || '',
        b.isbn13 || '', b.pages || '', b.lexile || '', b.foundAt || '', b.readIn || '',
        b.note || '', b.status || 'unread', b.coverUrl || '',
        b.sortOrder ?? id,
        id
      ).run();
      const row = await env.DB.prepare('SELECT * FROM books WHERE id = ?').bind(id).first();
      return row ? json(rowToBook(row)) : json({ error: 'Not found' }, 404);
    }

    // DELETE /api/books/:id
    const delMatch = path.match(/^\/api\/books\/(\d+)$/);
    if (method === 'DELETE' && delMatch) {
      const id = parseInt(delMatch[1]);
      await env.DB.prepare('DELETE FROM books WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }

    // POST /api/reorder — bulk update sort_order for a tab
    // Body: { tab: 'en', order: [id1, id2, id3, ...] }
    if (method === 'POST' && path === '/api/reorder') {
      const { tab, order } = await request.json();
      if (!tab || !Array.isArray(order)) return json({ error: 'Invalid' }, 400);
      for (let i = 0; i < order.length; i++) {
        await env.DB.prepare('UPDATE books SET sort_order = ? WHERE id = ? AND tab = ?')
          .bind(i + 1, order[i], tab).run();
      }
      return json({ ok: true });
    }

    // POST /api/import — bulk import
    if (method === 'POST' && path === '/api/import') {
      const { books } = await request.json();
      await env.DB.prepare('DELETE FROM books').run();
      // Group by tab to assign sort_order per tab
      const tabCounters = { en: 0, zh: 0, pending: 0 };
      for (const b of books) {
        const tab = b.tab || 'en';
        tabCounters[tab] = (tabCounters[tab] || 0) + 1;
        const sortOrder = b.sortOrder ?? tabCounters[tab];
        await env.DB.prepare(`
          INSERT INTO books (tab, title, series, author, publisher, isbn13, pages, lexile, found_at, read_in, note, status, cover_url, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          tab, b.title || '', b.series || '', b.author || '', b.publisher || '',
          b.isbn13 || '', b.pages || '', b.lexile || '', b.foundAt || '',
          b.readIn || '', b.note || '', b.status || 'unread', b.coverUrl || '',
          sortOrder,
        ).run();
      }
      return json({ ok: true, count: books.length });
    }

    // GET /api/tpml?q=QUERY — proxy search to Taipei Public Library
    if (method === 'GET' && path === '/api/tpml') {
      const q = url.searchParams.get('q');
      if (!q) return json({ error: 'Missing q' }, 400);

      try {
        // TPML WebPAC search URL (title search)
        const searchUrl = `https://book.tpml.edu.tw/webpac/search.cfm?searchtype=general&searchdata=${encodeURIComponent(q)}&searchfield=TP&searchcat=M`;
        const resp = await fetch(searchUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; LibrarySearch/1.0)',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'zh-TW,zh;q=0.9',
          }
        });
        if (!resp.ok) return json({ results: [], error: `TPML returned ${resp.status}` });

        const html = await resp.text();

        // Parse book entries from TPML search result HTML
        const results = parseTpmlResults(html);
        return json({ results });
      } catch (e) {
        return json({ results: [], error: e.message });
      }
    }

    return json({ error: 'Not found' }, 404);
  },
};

// Parse TPML WebPAC search result HTML
function parseTpmlResults(html) {
  const books = [];

  // TPML result rows typically contain: title, author, publisher, year, ISBN
  // Pattern: look for table rows with book data
  // The structure uses <div class="search_result"> or similar patterns

  // Extract title links - typically <a href="detail.cfm?...">TITLE</a>
  const titleRe = /<a[^>]+href=["'][^"']*detail\.cfm[^"']*["'][^>]*>\s*([^<]{2,}?)\s*<\/a>/gi;
  // Extract detail blocks containing metadata
  // TPML uses a table layout: each result in a <tr> with cells for 書名/著者/出版/年份/ISBN

  // Try to match result rows with structured data
  // TPML WebPAC HTML structure (as of 2024):
  // <td class="title_td"><a href="detail.cfm?bid=...">書名</a></td>
  // <td>著者</td><td>出版社</td><td>出版年</td><td>ISBN</td>

  // Match full result rows
  const rowRe = /<tr[^>]*class=["']?(?:odd|even|search_result)[^"']*["']?[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null && books.length < 10) {
    const row = rowMatch[1];
    // Extract cells
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(row)) !== null) {
      cells.push(stripHtml(cellMatch[1]).trim());
    }
    if (cells.length < 3) continue;

    // Try to extract title from anchor in row
    const titleMatch = row.match(/<a[^>]+href=["'][^"']*detail[^"']*["'][^>]*>\s*([\s\S]*?)\s*<\/a>/i);
    const title = titleMatch ? stripHtml(titleMatch[1]).trim() : cells[0];
    if (!title || title.length < 2) continue;

    // Guess field positions: title, author, publisher, year, isbn
    const author = cells[1] || '';
    const publisher = cells[2] || '';
    const isbn = cells.find(c => /^\d{10,13}$/.test(c.replace(/-/g,''))) || '';
    const isbn13 = isbn.replace(/-/g,'').length === 13 ? isbn.replace(/-/g,'') : '';

    books.push({ title, author, publisher, isbn13, source: 'tpml' });
  }

  // Fallback: extract title links if table parsing found nothing
  if (books.length === 0) {
    let m;
    while ((m = titleRe.exec(html)) !== null && books.length < 10) {
      const title = stripHtml(m[1]).trim();
      if (title.length >= 2 && !title.match(/^\s*$/)) {
        books.push({ title, author: '', publisher: '', isbn13: '', source: 'tpml' });
      }
    }
  }

  return books;
}

function stripHtml(str) {
  return str.replace(/<[^>]+>/g, ' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/&#\d+;/g,'').replace(/\s+/g,' ').trim();
}
