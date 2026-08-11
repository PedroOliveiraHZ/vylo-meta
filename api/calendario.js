

const NOTION_VERSION = '2022-06-28';

async function notionFetch(url, token, options = {}) {
  const r = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await r.json();
  if (!r.ok) {
    const err = new Error(data.message || `Notion API ${r.status}`);
    err.status = r.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

async function resolveDatabaseId(id, token) {
  try {
    await notionFetch(`https://api.notion.com/v1/databases/${id}`, token);
    return id;
  } catch (err) {
    if (err.code !== 'validation_error') throw err;
  }
  const children = await notionFetch(`https://api.notion.com/v1/blocks/${id}/children?page_size=50`, token);
  const dbBlock = (children.results || []).find(b => b.type === 'child_database');
  if (!dbBlock) {
    throw new Error(`O id ${id} é uma página, mas não achei nenhum banco de dados dentro dela.`);
  }
  return dbBlock.id;
}

async function fetchAllRows(rawId, token, sourceLabel) {
  const databaseId = await resolveDatabaseId(rawId, token);
  const results = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionFetch(`https://api.notion.com/v1/databases/${databaseId}/query`, token, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return results.map(page => extractRow(page.properties, sourceLabel));
}

export default async function handler(req, res) {
  const token = process.env.NOTION_TOKEN;
  const id1 = process.env.NOTION_DATABASE_ID;
  const id2 = process.env.NOTION_DATABASE_ID_2;

  if (!token || !id1) {
    res.status(500).json({ error: 'error.' });
    return;
  }

  try {
    const sources = [{ id: id1, label: 'Calendário Editorial' }];
    if (id2) sources.push({ id: id2, label: 'Comunidade' });

    const allRows = (await Promise.all(sources.map(s => fetchAllRows(s.id, token, s.label)))).flat();

    const rows = allRows.sort((a, b) => (a['Data'] || '').localeCompare(b['Data'] || ''));

    res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=60');
    res.status(200).json({ rows });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}

function textFromProp(prop) {
  if (!prop) return '';
  switch (prop.type) {
    case 'title':
      return prop.title.map(t => t.plain_text).join('');
    case 'rich_text':
      return prop.rich_text.map(t => t.plain_text).join('');
    case 'select':
      return prop.select ? prop.select.name : '';
    case 'status':
      return prop.status ? prop.status.name : '';
    case 'multi_select':
      return prop.multi_select.map(o => o.name).join(', ');
    case 'date':
      return prop.date ? prop.date.start : '';
    case 'people':
      return prop.people.map(p => p.name).join(', ');
    case 'checkbox':
      return prop.checkbox ? 'Sim' : 'Não';
    case 'number':
      return prop.number != null ? String(prop.number) : '';
    case 'url':
      return prop.url || '';
    case 'email':
      return prop.email || '';
    case 'formula':
      return textFromProp(prop.formula);
    default:
      return '';
  }
}

function extractRow(properties, sourceLabel) {
  const row = { '_source': sourceLabel };
  for (const [key, prop] of Object.entries(properties)) {
    row[key] = textFromProp(prop);
    if (prop.type === 'title' && !row['_title']) row['_title'] = row[key];
  }
  return row;
}
