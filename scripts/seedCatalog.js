// scripts/seedCatalog.js
// One-off: build catalog/products/<retailerId>/product.json (+ image.jpg)
// from products.txt (the live price list) and images/ (the product art).
//
//   node scripts/seedCatalog.js [--force]
//
// Existing product.json files are kept unless --force is given, so the
// script is safe to re-run after prices change.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCTS_DIR = path.join(root, 'catalog', 'products');
const IMAGES_DIR = path.join(root, 'images');
const FORCE = process.argv.includes('--force');

// images/<slug>.jpg where the art was named before the shelf name.
const IMAGE_ALIAS = {
  'telenor-zong-500mb': 'simfly-esim-500mb-no-expiry',
  'telenor-zong-1gb': 'simfly-esim-1gb-no-expiry',
  'telenor-zong-6gb': 'simfly-esim-6gb-no-expiry',
  'telenor-zong-10gb': 'simfly-esim-10gb-no-expiry',
  'chatgpt-plus-k12-edu-2-years': 'chatgpt-plus-2-years',
  // Gemini Pro 18 Months IS the Google AI Pro 18 Months SKU.
  'gemini-pro-18-months': 'google-ai-pro-18-months',
  'jetbrains-edu-pack-12-months': 'jetbrains-12-months',
  'factory-12-months': 'factory-ai-12-months',
  'figma-pro-edu-2-years': 'figma-pro-2-years',
  'framer-ai-1-year': 'framer-1-year',
  'microsoft-365-plus-1-year': 'microsoft-365-1-year',
  'miro-lifetime-100-seats': 'miro-100-seats',
  'edx-premium-12-months': 'edx-12-months',
  'coursera-premium': 'coursera',
  'apple-tv-link-12-months': 'apple-tv-12-months',
  'wispr-flow-edu-12-months': 'wispr-flow-12-months',
  'spotify-premium-redeem-link-3-months': 'spotify-premium-3-months',
  'duolingo-super-old-12-months': 'duolingo-super-12-months-2',
};

const slug = (s) => String(s)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 64)
  .replace(/-+$/g, '');

function parsePrice(text) {
  const n = Number(String(text).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// products.txt layout: Name | Duration | Description | Rs price
const rows = fs.readFileSync(path.join(root, 'products.txt'), 'utf8')
  .split(/\r?\n/)
  .filter((l) => /\| Rs [\d,]+$/.test(l))
  .map((line) => {
    const parts = line.split(' | ');
    const price = parsePrice(parts[parts.length - 1]);
    const name = parts[0].trim();
    const duration = parts[1] && parts[1] !== '-' ? parts[1].trim() : '';
    const description = parts.slice(2, -1).join(' | ').trim() || name;
    const retailerId = slug(duration ? `${name} ${duration}` : name);
    return { name, duration, description, price, retailerId };
  });

let created = 0;
let skipped = 0;
const noImage = [];

for (const row of rows) {
  if (!row.retailerId) continue;
  const folder = path.join(PRODUCTS_DIR, row.retailerId);
  const file = path.join(folder, 'product.json');
  if (fs.existsSync(file) && !FORCE) { skipped += 1; continue; }

  fs.mkdirSync(folder, { recursive: true });
  const product = {
    retailerId: row.retailerId,
    // The variant lives in the name: 3 Months and 12 Months are different SKUs.
    name: row.duration ? `${row.name} · ${row.duration}` : row.name,
    description: row.description,
    price: row.price,
    currency: 'PKR',
    originCountryCode: 'PK',
    availability: 'in stock',
    image: './image.jpg',
  };
  fs.writeFileSync(file, `${JSON.stringify(product, null, 2)}\n`, 'utf8');

  const wanted = IMAGE_ALIAS[row.retailerId] || row.retailerId;
  const source = path.join(IMAGES_DIR, `${wanted}.jpg`);
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, path.join(folder, 'image.jpg'));
  } else {
    delete product.image;
    fs.writeFileSync(file, `${JSON.stringify(product, null, 2)}\n`, 'utf8');
    noImage.push(row.retailerId);
  }
  created += 1;
}

console.log(`catalog seeded: ${created} created · ${skipped} kept · ${rows.length} total`);
if (noImage.length) console.log(`no image for ${noImage.length}: ${noImage.join(', ')}`);
