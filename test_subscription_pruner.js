const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.events = {}; this.textContent = ''; this.value = ''; this.checked = false; }
  append(...children) { for (const child of children) child.parent = this; this.children.push(...children); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener(key, fn) { this.events[key] = fn; }
  click() { if (this.download) downloadFilename = this.download; this.events.click?.(); }
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolled = true; }
}
const elementIds = ['cards', 'spend', 'saving', 'count', 'status', 'updated', 'source-label', 'quick-list', 'add-form', 'service-name', 'service-price', 'clear-button', 'export-button', 'undo-list', 'import-button', 'file', 'member-button', 'member-file'];
const html = fs.readFileSync('workspace/subscription_pruner.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const saved = new Map();
let allowClear = true;
let downloadBlob, downloadFilename;
const timers = new Map(); let nextTimer = 0;
const setTimeout = (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; };
const clearTimeout = id => timers.delete(id);
const advance = ms => { for (const [id, timer] of [...timers]) if (timer.ms <= ms && timers.delete(id)) timer.fn(); };
const URL = { createObjectURL: blob => { downloadBlob = blob; return 'blob:test'; }, revokeObjectURL() {} };
const localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
function createPage() {
  const ids = Object.fromEntries(elementIds.map(id => [id, new Element(id)]));
  const document = { createElement: tag => new Element(tag), getElementById: id => ids[id] };
  const page = vm.createContext({ document, location: { protocol: 'file:' }, localStorage, confirm: () => allowClear, setTimeout, clearTimeout, URL, Blob });
  vm.runInContext(script, page);
  return { ids, page };
}
const visit = (root, pred) => [root, ...root.children.flatMap(child => visit(child, pred))].filter(pred);
const find = (root, label) => visit(root, node => node.attrs['aria-label'] === label)[0];
const cardNames = ids => ids.cards.children.filter(x => x.className === 'card').map(card => visit(card, x => x.className === 'name')[0].textContent);
const change = (input, value) => { input.checked = value; input.events.change(); };

async function main() {
  let { ids, page } = createPage();
  assert.deepEqual(cardNames(ids), []);
  assert.equal(ids.cards.children[0].className, 'empty');
  assert.equal(ids.spend.textContent, '¥0.00');
  assert.equal(ids['clear-button'].disabled, true);
  assert.equal(ids['quick-list'].children.length, 10);

  page.officialData = JSON.parse(fs.readFileSync('workspace/subscription_cancellation_data.json', 'utf8'));
  vm.runInContext("loadData(officialData, '退订指引已就绪')", page);
  assert.deepEqual(cardNames(ids), []);
  assert.equal(ids.updated.textContent, '官方指引更新时间：2026-09');

  ids['quick-list'].children[0].click();
  assert.deepEqual(cardNames(ids), ['爱奇艺']);
  const card = ids.cards.children[0];
  assert.equal(visit(card, x => x.className === 'guide').length, 4);
  assert.equal(visit(card, x => x.tag === 'a' && x.href?.startsWith('https://')).length, 4);
  const current = find(card, '爱奇艺正在续费'), cancel = find(card, '爱奇艺计划退订'), price = find(card, '爱奇艺月费');
  assert.equal(current.checked, false);
  assert.equal(current.disabled, true);
  assert.equal(cancel.disabled, true);
  assert.equal(ids.spend.textContent, '¥0.00');
  price.value = '30.25'; price.events.input();
  assert.equal(ids.spend.textContent, '¥0.00');
  find(card, '确认 爱奇艺 实际月费').click();
  assert.equal(ids.spend.textContent, '¥363.00');
  const confirmedCard = ids.cards.children[0], confirmedCancel = find(confirmedCard, '爱奇艺计划退订');
  change(confirmedCancel, true);
  assert.equal(visit(confirmedCard, x => x.tag === 'details')[0].open, true);
  assert.equal(ids.spend.textContent, '¥363.00');
  assert.equal(ids.saving.textContent, '¥363.00');
  ids['quick-list'].children[0].click();
  assert.deepEqual(cardNames(ids), ['爱奇艺']);
  assert.equal(ids.cards.children[0].focused, true);
  assert.equal(ids.status.textContent.includes('已在清单中'), true);
  const confirmedPrice = find(confirmedCard, '爱奇艺月费');
  confirmedPrice.value = '-1'; confirmedPrice.events.input();
  assert.equal(confirmedPrice.attrs['aria-invalid'], 'true');
  assert.equal(ids.spend.textContent, '¥363.00');
  confirmedPrice.value = '2.345'; confirmedPrice.events.input();
  assert.equal(confirmedPrice.attrs['aria-invalid'], 'true');
  assert.equal(ids.spend.textContent, '¥363.00');

  ids['service-name'].value = 'WPS Office'; ids['service-price'].value = '19';
  ids['add-form'].events.submit({ preventDefault() {} });
  assert.deepEqual(cardNames(ids), ['爱奇艺', 'WPS Office']);
  assert.equal(visit(ids.cards.children[1], x => x.className === 'guide').length, 4);
  ids['quick-list'].children[6].click();
  assert.deepEqual(cardNames(ids), ['爱奇艺', 'WPS Office']);
  assert.equal(ids.spend.textContent, '¥591.00');

  ({ ids, page } = createPage());
  assert.deepEqual(cardNames(ids), ['爱奇艺', 'WPS Office']);
  assert.equal(ids.spend.textContent, '¥591.00');
  vm.runInContext("loadData(officialData, '退订指引已就绪')", Object.assign(page, { officialData: JSON.parse(fs.readFileSync('workspace/subscription_cancellation_data.json', 'utf8')) }));
  assert.equal(visit(ids.cards.children[1], x => x.className === 'guide').length, 4);

  const importFile = async (name, body) => {
    ids['member-file'].files = [{ name, size: Buffer.byteLength(body), text: async () => body }];
    await ids['member-file'].events.change({ target: ids['member-file'] });
  };
  await importFile('members.csv', 'name,monthly_price,active,cancel\n爱奇艺,31,true,true\n新会员,9.90,true,false\n');
  assert.deepEqual([...cardNames(ids)].sort(), ['WPS Office', '新会员', '爱奇艺'].sort());
  assert.equal(ids.spend.textContent, '¥718.80');
  const previous = [...saved.values()][0];
  await importFile('bad.csv', 'name,monthly_price\n爱奇艺,-2');
  assert.equal([...saved.values()][0], previous);
  ids['export-button'].click();
  assert.match(downloadFilename, /^我的自动续费清单-\d{4}-\d{2}-\d{2}\.json$/);
  const backup = await downloadBlob.text();
  assert.deepEqual(JSON.parse(backup).members.map(row => row.name), ['爱奇艺', 'WPS Office', '新会员']);
  find(ids.cards.children[2], '移出 新会员').click();
  assert.deepEqual(cardNames(ids), ['爱奇艺', 'WPS Office']);
  assert.equal(ids['undo-list'].children.length, 1);
  ids['undo-list'].children[0].children[1].click();
  assert.deepEqual(cardNames(ids), ['爱奇艺', 'WPS Office', '新会员']);
  find(ids.cards.children[0], '移出 爱奇艺').click();
  advance(3000);
  assert.equal(ids['undo-list'].children.length, 0);
  assert.deepEqual(cardNames(ids), ['WPS Office', '新会员']);
  await importFile('backup.json', backup);
  assert.deepEqual([...cardNames(ids)].sort(), ['爱奇艺', 'WPS Office', '新会员'].sort());
  assert.equal(ids.spend.textContent, '¥718.80');
  allowClear = false; ids['clear-button'].click();
  assert.equal(cardNames(ids).length, 3);
  allowClear = true; ids['clear-button'].click();
  assert.deepEqual(cardNames(ids), []);
  assert.equal(ids.cards.children[0].className, 'empty');
  ({ ids } = createPage());
  assert.deepEqual(cardNames(ids), []);
  console.log('PASS: quick price confirmation, guide expansion, removal undo/expiry, JSON export/restore, import, persistence and clear');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
