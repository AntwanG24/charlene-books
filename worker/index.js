// Charlene Book List - Cloudflare Worker API
// All routes: /api/books

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
    addedAt:   row.added_at,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { method } = request;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const path = url.pathname;

    // GET /api/books?tab=en|zh|pending
    if (method === 'GET' && path === '/api/books') {
      const tab = url.searchParams.get('tab');
      let stmt;
      if (tab && ['en','zh','pending'].includes(tab)) {
        stmt = env.DB.prepare('SELECT * FROM books WHERE tab = ? ORDER BY added_at ASC').bind(tab);
      } else {
        stmt = env.DB.prepare('SELECT * FROM books ORDER BY tab, added_at ASC');
      }
      const { results } = await stmt.all();
      return json(results.map(rowToBook));
    }

    // POST /api/books  — create
    if (method === 'POST' && path === '/api/books') {
      const b = await request.json();
      const stmt = env.DB.prepare(`
        INSERT INTO books (tab, title, series, author, publisher, isbn13, pages, lexile, found_at, read_in, note, status, cover_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        b.tab || 'en',
        b.title || '',
        b.series || '',
        b.author || '',
        b.publisher || '',
        b.isbn13 || '',
        b.pages || '',
        b.lexile || '',
        b.foundAt || '',
        b.readIn || '',
        b.note || '',
        b.status || 'unread',
        b.coverUrl || '',
      );
      const result = await stmt.run();
      const newId = result.meta.last_row_id;
      const row = await env.DB.prepare('SELECT * FROM books WHERE id = ?').bind(newId).first();
      return json(rowToBook(row), 201);
    }

    // PUT /api/books/:id  — update
    const putMatch = path.match(/^\/api\/books\/(\d+)$/);
    if (method === 'PUT' && putMatch) {
      const id = parseInt(putMatch[1]);
      const b = await request.json();
      await env.DB.prepare(`
        UPDATE books SET
          tab = ?, title = ?, series = ?, author = ?, publisher = ?,
          isbn13 = ?, pages = ?, lexile = ?, found_at = ?, read_in = ?,
          note = ?, status = ?, cover_url = ?
        WHERE id = ?
      `).bind(
        b.tab, b.title, b.series || '', b.author || '', b.publisher || '',
        b.isbn13 || '', b.pages || '', b.lexile || '', b.foundAt || '', b.readIn || '',
        b.note || '', b.status || 'unread', b.coverUrl || '',
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

    // POST /api/import  — bulk import (replaces all data)
    if (method === 'POST' && path === '/api/import') {
      const { books } = await request.json();
      // Clear all
      await env.DB.prepare('DELETE FROM books').run();
      // Insert in batches
      for (const b of books) {
        await env.DB.prepare(`
          INSERT INTO books (tab, title, series, author, publisher, isbn13, pages, lexile, found_at, read_in, note, status, cover_url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          b.tab || 'en',
          b.title || '',
          b.series || '',
          b.author || '',
          b.publisher || '',
          b.isbn13 || '',
          b.pages || '',
          b.lexile || '',
          b.foundAt || '',
          b.readIn || '',
          b.note || '',
          b.status || 'unread',
          b.coverUrl || '',
        ).run();
      }
      return json({ ok: true, count: books.length });
    }

    return json({ error: 'Not found' }, 404);
  },
};
