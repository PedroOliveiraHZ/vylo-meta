// Vercel Serverless Function
// Busca as linhas do banco de dados "Calendários Editoriais" no Notion
// usando um token de integração guardado em variável de ambiente (nunca exposto ao navegador).
//
// Variáveis de ambiente necessárias (configurar em Vercel > Project > Settings > Environment Variables):
//   NOTION_TOKEN         -> o "Internal Integration Secret" da integração criada em notion.so/my-integrations
//   NOTION_DATABASE_ID   -> o id do banco de dados "Calendários Editoriais" (compartilhado com a integração)

export default async function handler(req, res) {
  const token = process.env.NOTION_TOKEN;
  const databaseId = process.env.NOTION_DATABASE_ID;

  if (!token || !databaseId) {
    res.status(500).json({ error: 'NOTION_TOKEN ou NOTION_DATABASE_ID não configurados nas variáveis de ambiente da Vercel.' });
    return;
  }

  try {
    const results = [];
    let cursor;
    do {
      const body = { page_size: 100, sorts: [{ property: 'Data', direction: 'ascending' }] };
      if (cursor) body.start_cursor = cursor;

      const r = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!r.ok) {
        const errText = await r.text();
        throw new Error(`Notion API ${r.status}: ${errText}`);
      }

      const data = await r.json();
      results.push(...data.results);
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);

    const rows = results.map(page => extractRow(page.properties));

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

function extractRow(properties) {
  const row = {};
  for (const [key, prop] of Object.entries(properties)) {
    row[key] = textFromProp(prop);
  }
  return row;
}
