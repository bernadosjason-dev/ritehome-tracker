// Fills templates/construction-contract.html from a JSON file and prints it to an A4 PDF (Chromium, backgrounds on,
// 12 mm top/bottom and 14 mm side margins), then checks the arithmetic and reports the page count.
//   node templates/render-contract.cjs <contract.json> <out.pdf>
// JSON: { contract_no, date, representative, owner, owner_address, site, start_date, working_days, lead_weeks,
//         items: [{ title, spec, price }], milestones: [{ label, share }] }
// Any field left out or null prints as a blank underlined line; "[BLANK]" inside a spec does too.
// Payment amounts are computed: each share of the contract price, rounded to centavos, and the last milestone takes
// what is left, so the milestones always add up to the contract price exactly. Shares must add up to 100.
// Keep the JSON and the PDF out of this repo (client data, public repo): the scratchpad or the owner's own files.
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');

const [, , input, output] = process.argv;
if (!input || !output) { console.error('usage: node templates/render-contract.cjs <contract.json> <out.pdf>'); process.exit(2); }
const c = JSON.parse(fs.readFileSync(input, 'utf8'));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const blank = (size) => `<span class="blank${size ? ' ' + size : ''}"></span>`;
const field = (v, size) => (v == null || v === '' ? blank(size) : esc(v));
const cents = (n) => Math.round(n * 100);
const peso = (c100) => (c100 / 100).toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

const items = c.items || [];
if (!items.length) throw new Error('No items.');
const totalC = items.reduce((s, it) => s + cents(it.price), 0);
const shares = (c.milestones || []).map((m) => Number(m.share));
if (shares.reduce((a, b) => a + b, 0) !== 100) throw new Error('Milestone shares must add up to 100, not ' + shares.reduce((a, b) => a + b, 0));
let left = totalC;
const ms = c.milestones.map((m, i, all) => {
  const amt = i === all.length - 1 ? left : Math.round(totalC * Number(m.share) / 100);
  left -= amt;
  return {label: esc(m.label), share: esc(m.share), amount: peso(amt), c: amt};
});
if (ms.reduce((s, m) => s + m.c, 0) !== totalC) throw new Error('Milestones do not add up to the contract price.');

const spec = (s) => (s ? esc(s).replace(/\[BLANK\]/g, blank('l')) : '');
const rows = (block, list, fn) => list.map(fn).join('');
let html = fs.readFileSync(path.join(__dirname, 'construction-contract.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
html = html.replace(/\{\{#items\}\}([\s\S]*?)\{\{\/items\}\}/, (_, row) => rows(row, items, (it, i) =>
  row.replace('{{n}}', i + 1).replace('{{title}}', esc(it.title)).replace('{{spec}}', spec(it.spec)).replace('{{price}}', peso(cents(it.price)))));
html = html.replace(/\{\{#milestones\}\}([\s\S]*?)\{\{\/milestones\}\}/, (_, row) => rows(row, ms, (m) =>
  row.replace('{{label}}', m.label).replace('{{share}}', m.share).replace('{{amount}}', m.amount)));
const n = items.length;
const values = {
  logo: 'file://' + path.join(__dirname, '..', 'brand', 'logo-mark.png'),
  contract_no: field(c.contract_no, 's'), date: field(c.date, 's'), representative: field(c.representative),
  owner: c.owner ? esc(c.owner) : blank('m') + ' (full name)', owner_address: c.owner_address ? esc(c.owner_address) : blank('m') + ' (address)',
  site: field(c.site, 'l'), start_date: field(c.start_date, 's'), working_days: field(c.working_days, 'xs'), lead_weeks: field(c.lead_weeks, 'xs'),
  item_count_words: (words[n] || n) + (n === 1 ? ' item' : ' items'), total: peso(totalC),
};
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
  console.log(`Contract price ${peso(totalC)}; ` + ms.map((m) => `${m.share}% ${m.amount}`).join(', ') + `; ${pages} page(s) -> ${output}`);
})().catch((e) => { console.error(e); process.exit(1); });
