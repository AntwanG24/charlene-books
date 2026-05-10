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

    return json({ error: 'Not found' }, 404);
  },
};
