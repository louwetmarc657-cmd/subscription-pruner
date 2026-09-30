const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = __dirname;
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = fs.mkdtempSync(path.join(root, 'subscription-edge-'));
const fixture = path.join(root, 'member-browser-test.csv');
const server = http.createServer((req, res) => {
  const files = { '/subscription_pruner.html': 'subscription_pruner.html', '/subscription_cancellation_data.json': 'subscription_cancellation_data.json' };
  const file = files[req.url];
  if (!file) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8');
  fs.createReadStream(path.join(root, file)).pipe(res);
});

async function main() {
  if (!fs.existsSync(edgePath)) throw Error('未找到 Edge 浏览器');
  fs.writeFileSync(fixture, 'name,monthly_price,active,cancel\n爱奇艺,30.50,true,true\n新增会员,9.90,true,false\n');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const edge = spawn(edgePath, ['--headless=new', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let ws, send;
  try {
    let debugPort;
    for (let i = 0; i < 100; i++) {
      const portFile = path.join(profile, 'DevToolsActivePort');
      if (fs.existsSync(portFile)) { debugPort = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]); break; }
      if (edge.exitCode !== null) throw Error(`Edge 提前退出：${edge.exitCode}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!debugPort) throw Error('Edge 调试端口启动超时');
    const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
    ws = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    const pending = new Map(); let id = 0;
    ws.onmessage = event => {
      const msg = JSON.parse(event.data);
      if (!pending.has(msg.id)) return;
      const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    };
    await new Promise(resolve => ws.onopen = resolve);
    send = (method, params = {}) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); ws.send(JSON.stringify({ id: next, method, params })); });
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    const snapshot = () => evaluate(`(() => ({source:document.querySelector('#source-label').textContent,names:[...document.querySelectorAll('.card .name')].map(x=>x.textContent),empty:!!document.querySelector('.empty'),quick:document.querySelectorAll('#quick-list button').length,guides:document.querySelectorAll('.card .guide').length,guideOpen:document.querySelector('.card details')?.open,spend:document.querySelector('#spend').textContent,saving:document.querySelector('#saving').textContent,status:document.querySelector('#status').textContent,advanced:document.querySelector('.advanced').open}))()`);
    const waitFor = async predicate => { let value; for (let i = 0; i < 50; i++) { value = await snapshot(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); } throw Error(`页面状态等待超时：${JSON.stringify(value)}`); };

    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/subscription_pruner.html` });
    await waitFor(state => state.source === '退订指引已就绪');
    await evaluate("localStorage.removeItem('subscription-pruner-members-v1')");
    await send('Page.reload');
    const initial = await waitFor(state => state.source === '退订指引已就绪');
    assert.deepEqual(initial.names, []);
    assert.equal(initial.empty, true);
    assert.equal(initial.quick, 10);
    assert.equal(initial.advanced, false);
    await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    fs.writeFileSync(path.join(root, 'subscription_pruner_empty.png'), Buffer.from((await send('Page.captureScreenshot', { captureBeyondViewport: true })).data, 'base64'));

    await evaluate("document.querySelectorAll('#quick-list button')[0].click()");
    const added = await waitFor(state => state.names.length === 1);
    assert.deepEqual(added.names, ['爱奇艺']);
    assert.equal(added.guides, 4);
    assert.equal(added.spend, '¥0.00');
    assert.equal(await evaluate("document.querySelector('.card input[aria-label=\"爱奇艺正在续费\"]').disabled"), true);
    await evaluate("document.querySelector('.card button[aria-label=\"确认 爱奇艺 实际月费\"]').click()");
    assert.equal((await snapshot()).spend, '¥300.00');
    await evaluate("document.querySelectorAll('#quick-list button')[0].click()");
    assert.equal((await snapshot()).names.length, 1);
    assert.equal((await snapshot()).status.includes('已在清单中'), true);

    await evaluate("document.querySelector('#service-name').value='WPS Office';document.querySelector('#service-price').value='19';document.querySelector('#service-price').focus()");
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const manual = await waitFor(state => state.names.length === 2);
    assert.deepEqual(manual.names, ['爱奇艺', 'WPS Office']);
    assert.equal(manual.guides, 8);
    assert.equal(manual.spend, '¥528.00');
    fs.writeFileSync(path.join(root, 'subscription_pruner_added.png'), Buffer.from((await send('Page.captureScreenshot', { captureBeyondViewport: true })).data, 'base64'));

    await evaluate("document.querySelector('.advanced').open=true");
    const dom = await send('DOM.getDocument');
    const node = await send('DOM.querySelector', { nodeId: dom.root.nodeId, selector: '#member-file' });
    await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [fixture] });
    const imported = await waitFor(state => state.status.startsWith('已合并'));
    assert.deepEqual(imported.names, ['爱奇艺', 'WPS Office', '新增会员']);
    assert.equal(imported.spend, '¥712.80');
    assert.equal(imported.saving, '¥366.00');
    assert.equal(imported.guideOpen, true);
    await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: profile });
    await evaluate("document.querySelector('#export-button').click()");
    let backup;
    for (let i = 0; i < 50; i++) {
      const file = fs.readdirSync(profile).find(name => name.startsWith('我的自动续费清单-') && name.endsWith('.json'));
      if (file) { backup = JSON.parse(fs.readFileSync(path.join(profile, file), 'utf8')); break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.deepEqual(backup?.members.map(row => row.name), imported.names);
    await evaluate("document.querySelector('.card button[aria-label=\"移出 爱奇艺\"]').click()");
    assert.deepEqual((await snapshot()).names, ['WPS Office', '新增会员']);
    await evaluate("document.querySelector('#undo-list button').click()");
    assert.deepEqual((await snapshot()).names, imported.names);
    await send('Page.reload');
    const reloaded = await waitFor(state => state.source === '退订指引已就绪' && state.names.length === 3);
    assert.equal(reloaded.spend, '¥712.80');
    await evaluate("window.confirm=()=>true;document.querySelector('#clear-button').click()");
    assert.equal((await snapshot()).empty, true);
    await send('Page.reload');
    const cleared = await waitFor(state => state.source === '退订指引已就绪');
    assert.deepEqual(cleared.names, []);
    assert.equal(cleared.empty, true);
    console.log('PASS: Edge quick confirmation, guide expansion, removal undo, JSON download, import, reload and clear');
  } finally {
    if (ws?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {});
    ws?.close(); edge.kill();
    fs.rmSync(fixture, { force: true });
    server.closeAllConnections(); server.close();
    await new Promise(resolve => setTimeout(resolve, 300));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
