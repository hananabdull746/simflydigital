import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'products.txt');
const src = fs.readFileSync(file, 'utf8').split(/\r?\n/);

const header = [];
const body = [];
let inHeader = true;
for (const l of src) {
  if (inHeader) {
    header.push(l);
    if (/^====/.test(l) && header.length > 3) inHeader = false;
    continue;
  }
  body.push(l);
}

const out = [];
let cur = null;
let count = 0;

const flush = () => {
  if (!cur) return;
  out.push(`${cur.name} | ${cur.dur || '-'} | ${cur.desc || '-'} | Rs ${cur.price}`);
  cur = null;
};

for (const line of body) {
  let m;
  if ((m = line.match(/^\s*\d+\.\s+(.+?)\s*$/))) {
    flush();
    const parts = m[1].split('·').map((s) => s.trim());
    cur = { name: parts[0], dur: parts.slice(1).join(' · '), desc: '', price: '' };
    count++;
  } else if (cur && (m = line.match(/^\s*Price\s*:\s*(?:PKR|Rs\.?)\s*([\d,.]+)/i))) {
    cur.price = m[1];
  } else if (cur && (m = line.match(/^\s*Desc\s*:\s*(.*)$/))) {
    cur.desc = m[1].trim();
  } else if (/^\s*Note\s*:/.test(line)) {
    // stock notes are dropped in the new layout
  } else if (line.trim()) {
    flush();
    out.push(line.trimEnd());
  }
}
flush();

const text = header.join('\r\n').replace(/\s+$/, '') + '\r\n\r\n' +
  out.map((l) => l.replace(/\s+$/, '')).join('\r\n') + '\r\n';

fs.writeFileSync(file, text, 'utf8');
console.log(`products: ${count}, lines: ${out.length}`);
