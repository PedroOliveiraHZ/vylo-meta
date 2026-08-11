// Vercel Serverless Function
// Busca as linhas do banco de dados "Calendários Editoriais" no Notion
// usando um token de integração guardado em variável de ambiente (nunca exposto ao navegador).
//
// Variáveis de ambiente necessárias (configurar em Vercel > Project > Settings > Environment Variables):
//   NOTION_TOKEN         -> o "Internal Integration Secret" da integração criada em notion.so/my-integrations
//   NOTION_DATABASE_ID   -> id da página OU do banco "Calendários Editoriais" (compartilhado com a integração).
//                           Se for o id de uma página que contém o banco dentro, a function acha o banco sozinha.

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
  // Tenta como banco de dados direto.
  try {
    await notionFetch(`https://api.notion.com/v1/databases/${id}`, token);
    return id;
  } catch (err) {
    if (err.code !== 'validation_error') throw err;
  }
  // Não é um banco -> deve ser uma página. Procura um banco filho dentro dela.
  const children = await notionFetch(`https://api.notion.com/v1/blocks/${id}/children?page_size=50`, token);
  const dbBlock = (children.results || []).find(b => b.type === 'child_database');
  if (!dbBlock) {
    throw new Error(`O id ${id} é uma página, mas não achei nenhum banco de dados dentro dela.`);
  }
  return dbBlock.id;
}

export default async function handler(req, res) {
  const token = process.env.NOTION_TOKEN;
  const rawId = process.env.NOTION_DATABASE_ID;

  if (!token || !rawId) {
    res.status(500).json({ error: 'NOTION_TOKEN ou NOTION_DATABASE_ID não configurados nas variáveis de ambiente da Vercel.' });
    return;
  }

  try {
    const databaseId = await resolveDatabaseId(rawId, token);

    const results = [];
    let cursor;
    do {
      const body = { page_size: 100, sorts: [{ property: 'Data', direction: 'ascending' }] };
      if (cursor) body.start_cursor = cursor;

      const data = await notionFetch(`https://api.notion.com/v1/databases/${databaseId}/query`, token, {
        method: 'POST',
        body: JSON.stringify(body),
      });

      results.push(...data.results);
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);

    const rows = results.map(page => extractRow(page.properties));

    res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=60');
    res.status(200).json({ rows, databaseId });
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

function extractRow(properties) {
  const row = {};
  for (const [key, prop] of Object.entries(properties)) {
    row[key] = textFromProp(prop);
  }
  return row;
}
