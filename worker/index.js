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
      const probe = url.searchParams.get('probe'); // probe=1 returns raw GraphQL responses for debugging
      if (!q) return json({ error: 'Missing q' }, 400);

      const gqlUrl = 'https://book.tpml.edu.tw/api/HyLibWS/graphql';
      const gqlHdrs = {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
        'Origin': 'https://book.tpml.edu.tw',
        'Referer': 'https://book.tpml.edu.tw/',
      };

      try {
        // Step 1: Call queryGrouping to establish search context and get hyftdToken
        const groupBody = {
          operationName: "queryGrouping",
          variables: {
            searchForm: {
              searchField: ["FullText"],
              searchInput: [q],
              op: [],
              pageNo: 1,
              pageSize: 10,
            }
          },
          query: `query queryGrouping($searchForm: SearchForm) {
            queryGrouping(searchForm: $searchForm) {
              hyftdToken
              groupList { groupKey groupCount { key count } }
            }
          }`
        };

        const groupResp = await fetch(gqlUrl, { method: 'POST', headers: gqlHdrs, body: JSON.stringify(groupBody) });
        const groupData = await groupResp.json();
        const hyftdToken = groupData?.data?.queryGrouping?.hyftdToken;

        if (probe) {
          // Return debug info: the token and then attempt searchSimpleList
          const debugInfo = { step1_status: groupResp.status, hyftdToken, step1_data: JSON.stringify(groupData).slice(0, 2000) };

          if (hyftdToken) {
            const listBody = {
              operationName: "searchSimpleList",
              variables: { hyftdToken, pageNo: 1, pageSize: 10 },
              query: `query searchSimpleList($hyftdToken: Int, $pageNo: Int, $pageSize: Int) {
                searchSimpleList(hyftdToken: $hyftdToken, pageNo: $pageNo, pageSize: $pageSize) {
                  total
                  list {
                    id title author publisher publicationYear isbn coverImageUrl
                  }
                }
              }`
            };
            const listResp = await fetch(gqlUrl, { method: 'POST', headers: gqlHdrs, body: JSON.stringify(listBody) });
            const listText = await listResp.text();
            debugInfo.step2_status = listResp.status;
            debugInfo.step2_data = listText.slice(0, 5000);
          }

          return json(debugInfo);
        }

        if (!hyftdToken) {
          return json({ results: [], error: 'No search token from TPML' });
        }

        // Step 2: Use hyftdToken to fetch actual book list
        const listBody = {
          operationName: "searchSimpleList",
          variables: { hyftdToken, pageNo: 1, pageSize: 10 },
          query: `query searchSimpleList($hyftdToken: Int, $pageNo: Int, $pageSize: Int) {
            searchSimpleList(hyftdToken: $hyftdToken, pageNo: $pageNo, pageSize: $pageSize) {
              total
              list {
                id title author publisher publicationYear isbn coverImageUrl
              }
            }
          }`
        };

        const listResp = await fetch(gqlUrl, { method: 'POST', headers: gqlHdrs, body: JSON.stringify(listBody) });
        const listData = await listResp.json();
        const list = listData?.data?.searchSimpleList?.list || [];

        const results = list.map(b => ({
          title: b.title || '',
          author: b.author || '',
          publisher: b.publisher || '',
          isbn13: (b.isbn || '').replace(/-/g, ''),
          coverUrl: b.coverImageUrl || '',
          source: 'tpml',
        }));

        return json({ results, total: listData?.data?.searchSimpleList?.total ?? 0 });
      } catch (e) {
        return json({ results: [], error: e.message });
      }
    }

    return json({ error: 'Not found' }, 404);
  },
};

