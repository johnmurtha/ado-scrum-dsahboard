import { toPng } from 'html-to-image';

export function exportCsv(filename, rows, { bom = false } = {}) {
  const escape = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = rows.map((r) => r.map(escape).join(',')).join('\r\n');
  // The BOM makes Excel read the file as UTF-8 instead of mangling accents.
  const blob = new Blob([bom ? `\uFEFF${csv}` : csv], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, filename);
}

// "M/D/YYYY H:mm" in the browser's local time, the shape ADO's own CSV export
// uses (no padding on month, day or hour; 24-hour clock; no seconds).
export function formatLocalDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${d.getHours()}:${mm}`;
}

// Spreadsheets run text cells that start with these characters as formulas, and
// work item titles are free text anyone on the project can edit. Prefixing an
// apostrophe makes them display literally. Numbers are left alone.
export function neutralizeFormula(v) {
  return typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

export async function exportPng(node, filename) {
  if (!node) return;
  const dataUrl = await toPng(node, { backgroundColor: '#ffffff', pixelRatio: 2 });
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  triggerDownload(blob, filename);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
