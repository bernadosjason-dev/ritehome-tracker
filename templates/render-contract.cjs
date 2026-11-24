// Fills one of the owner's contract templates from a JSON file and prints it to an A4 PDF (Chromium, backgrounds on,
// 12 mm top/bottom and 14 mm side margins), checks the arithmetic and reports the page count.
//   node templates/render-contract.cjs <contract.json> <out.pdf>
//
// "template": "construction" (default) -> templates/construction-contract.html, the kitchen-and-ceiling contract:
//   { contract_no, date, representative, owner, owner_address, site, start_date, working_days, lead_weeks,
//     items: [{ title, spec, price }], milestones: [{ label, share }] }
//   Milestone amounts are computed: each share of the contract price, rounded to centavos, the last one taking what is
//   left, so they always add up to the contract price. Shares must add up to 100.
// "template": "renovation" -> templates/renovation-contract.html, the renovation contract (50% down, 50% progress billing):
//   { contract_no, date, representative, owner, owner_address, project, site,
//     items: [{ n, work, materials_by, price }], time, work_rules: [..], materials, not_included: [..], warranty }
//   Downpayment = half the contract price rounded to centavos; balance = the rest. Fields left out take the wording of the
//   contract the owner approved (DEFAULTS below); "project" defaults to "Renovation of the Owner's house".
//
// Any field left out or null prints as a blank underlined line; "[BLANK]" inside a text does too.
// Keep the JSON and the PDF out of this repo (client data, public repo): the scratchpad or the owner's own files.
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');

const [, , input, output] = process.argv;
if (!input || !output) { console.error('usage: node templates/render-contract.cjs <contract.json> <out.pdf>'); process.exit(2); }
const c = JSON.parse(fs.readFileSync(input, 'utf8'));
const kind = c.template || 'construction';
if (!['construction', 'renovation'].includes(kind)) throw new Error('Unknown template: ' + kind);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const blank = (size) => `<span class="blank${size ? ' ' + size : ''}"></span>`;
const text = (s, size) => (s == null || s === '' ? blank(size) : esc(s).replace(/\[BLANK\]/g, blank('l')));
const cents = (n) => { const v = Math.round(Number(n) * 100); if (!Number.isFinite(v)) throw new Error('Not a price: ' + n); return v; };
const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

const items = c.items || [];
if (!items.length) throw new Error('No items.');
const totalC = items.reduce((s, it) => s + cents(it.price), 0);
// The kitchen-and-ceiling contract prints centavos; the renovation contract prints whole pesos unless a figure has centavos.
const wholeOnly = kind === 'renovation' && items.every((it) => cents(it.price) % 100 === 0) && totalC % 200 === 0;
const peso = (c100) => (c100 / 100).toLocaleString('en-PH', wholeOnly ? {maximumFractionDigits: 0} : {minimumFractionDigits: 2, maximumFractionDigits: 2});

const DEFAULTS = {
  project: "Renovation of the Owner's house",
  time: 'Start date: to be decided.',
  work_rules: [],
  materials: 'Owner buys the tiles and materials and must deliver them on time. If the crew has to wait because Owner\'s materials are late, waiting time costs PHP 2,000 per crew day, added to the next payment.',
  not_included: ['Hidden damage found after demolition. Contractor reports it with photos and a price, and works on it only after Owner agrees in writing.', 'Permits.'],
  warranty: '1 year on waterproofing and 6 months on all other work, counted from turnover. Damage from misuse, from defects in materials Owner chose, or from work by others is not covered.',
};
const pick = (k) => (c[k] !== undefined ? c[k] : DEFAULTS[k]);

const repeat = (html, name, list, fn) => html.replace(new RegExp(`\\{\\{#${name}\\}\\}([\\s\\S]*?)\\{\\{\\/${name}\\}\\}`), (_, row) =>
  list.map((x, i) => row.replace(/\{\{(\w+)\}\}/g, (m, k) => { const v = fn(x, i)[k]; if (v === undefined) throw new Error(`No value for {{${k}}} in ${name}`); return v; })).join(''));

const file = path.join(__dirname, kind + '-contract.html');
let html = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const values = {
  logo: 'file://' + path.join(__dirname, '..', 'brand', 'logo-mark.png'),
  contract_no: text(c.contract_no, 's'), date: text(c.date, 's'), representative: text(c.representative),
  total: peso(totalC),
};
let summary;
if (kind === 'construction') {
  const shares = (c.milestones || []).map((m) => Number(m.share));
  if (shares.reduce((a, b) => a + b, 0) !== 100) throw new Error('Milestone shares must add up to 100, not ' + shares.reduce((a, b) => a + b, 0));
  let left = totalC;
  const ms = c.milestones.map((m, i, all) => { const amt = i === all.length - 1 ? left : Math.round(totalC * Number(m.share) / 100); left -= amt; return {m, amt}; });
  if (ms.reduce((s, x) => s + x.amt, 0) !== totalC) throw new Error('Milestones do not add up to the contract price.');
  html = repeat(html, 'items', items, (it, i) => ({n: String(i + 1), title: esc(it.title), spec: it.spec ? text(it.spec) : '', price: peso(cents(it.price))}));
  html = repeat(html, 'milestones', ms, (x) => ({label: esc(x.m.label), share: esc(x.m.share), amount: peso(x.amt)}));
  const n = items.length;
  Object.assign(values, {
    owner: c.owner ? esc(c.owner) : blank('m') + ' (full name)', owner_address: c.owner_address ? esc(c.owner_address) : blank('m') + ' (address)',
    site: text(c.site, 'l'), start_date: text(c.start_date, 's'), working_days: text(c.working_days, 'xs'), lead_weeks: text(c.lead_weeks, 'xs'),
    item_count_words: (words[n] || n) + (n === 1 ? ' item' : ' items'),
  });
  summary = ms.map((x) => `${x.m.share}% ${peso(x.amt)}`).join(', ');
} else {
  const down = Math.round(totalC / 2), balance = totalC - down;
  html = repeat(html, 'items', items, (it, i) => ({n: esc(it.n != null ? it.n : i + 1), work: text(it.work), materials_by: esc(it.materials_by || '-'), price: peso(cents(it.price))}));
  html = repeat(html, 'work_rules', pick('work_rules'), (t) => ({text: text(t)}));
  html = repeat(html, 'not_included', pick('not_included'), (t) => ({text: text(t)}));
  Object.assign(values, {
    owner: text(c.owner), owner_address: text(c.owner_address, 'l'), owner_sign: c.owner ? esc(c.owner) : '<span class="blank" style="min-width:30mm"></span>',
    project: esc(pick('project')), site: text(c.site, 'l'), down: peso(down), balance: peso(balance),
    time: text(pick('time')), materials: text(pick('materials')), warranty: text(pick('warranty')),
  });
  summary = `50% down ${peso(down)}, 50% progress billing ${peso(balance)}`;
}
html = html.replace(/\{\{(\w+)\}\}/g, (_, k) => { if (!(k in values)) throw new Error('No value for {{' + k + '}}'); return values[k]; });

(async () => {
  const tmp = path.join(path.dirname(path.resolve(output)), path.basename(output, '.pdf') + '.html');
  fs.writeFileSync(tmp, html);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('file://' + tmp, {waitUntil: 'load'});
    await page.pdf({path: output, format: 'A4', printBackground: true, margin: {top: '12mm', bottom: '12mm', left: '14mm', right: '14mm'}});
  } finally { await browser.close(); }
  const pages = (fs.readFileSync(output, 'latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  console.log(`${kind} contract: price ${peso(totalC)}; ${summary}; ${pages} page(s) -> ${output}`);
})().catch((e) => { console.error(e); process.exit(1); });
