// Stable, visually distinct colors for per-person lines.
const PALETTE = [
  '#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed',
  '#0891b2', '#db2777', '#65a30d', '#ea580c', '#0d9488',
  '#9333ea', '#ca8a04', '#e11d48', '#4f46e5', '#059669',
];

export function colorForIndex(i) {
  return PALETTE[i % PALETTE.length];
}
