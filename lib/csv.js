'use strict';

// Tiny CSV parser — no deps. Handles quoted fields, escaped quotes, BOM.
// Returns { columns: string[], rows: Record<string, string>[] }.

function parseCsv(text) {
  if (!text) return { columns: [], rows: [] };

  // Strip BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let i = 0;
  let row = [];
  let field = '';
  let inQuotes = false;

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }

    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  // Tail
  if (field.length || row.length) { row.push(field); rows.push(row); }

  if (rows.length === 0) return { columns: [], rows: [] };

  const columns = rows[0].map(s => s.trim());
  const objects = rows.slice(1)
    .filter(r => r.some(v => v && v.trim()))
    .map(r => {
      const o = {};
      columns.forEach((col, idx) => { o[col] = (r[idx] ?? '').trim(); });
      return o;
    });

  return { columns, rows: objects };
}

module.exports = { parseCsv };
