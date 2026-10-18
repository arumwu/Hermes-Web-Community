const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function page(t) {
  const { Window } = await import('happy-dom');
  const window = new Window({ url: 'http://localhost/mobile/' });
  window.document.body.innerHTML = '<div class="brand-mark"></div><small id="connection-state"></small><main id="main"></main><nav id="dock"></nav><div id="notice"></div>';
  const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
  window.eval(source.replace('  init();', '  window.testApp = {state, render, mobilePush, mobileBack, mobileReset, mobileDialog};'));
  const app = window.testApp;
  Object.assign(app.state, { me: { authenticated: true, account_scope: 'fixture-owner' }, profile: 'demo' });
  app.mobileReset(); app.render();
  t.after(() => window.happyDOM.abort());
  return { window, ...app };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

test('browser back returns to the source tab and retains an unfinished field', async t => {
  const p = await page(t), main = p.window.document.querySelector('main');
  p.state.tab = 'tasks'; main.innerHTML = '<h1>任務來源</h1><input aria-label="未存草稿">';
  main.querySelector('input').value = '保留這份編輯';
  p.mobilePush(); p.state.tab = 'me'; main.innerHTML = '<h1>下一層</h1>';
  p.mobileBack(); await settle();
  assert.equal(p.state.tab, 'tasks');
  assert.equal(main.querySelector('input').value, '保留這份編輯');
  assert.equal(p.window.history.state.page, 0);
});

test('history contains only opaque routing markers, never drafts or profile data', async t => {
  const p = await page(t);
  p.state.profileDoc = { content: 'PRIVATE_DRAFT_MARKER' };
  p.mobilePush();
  assert.deepEqual(Object.keys(p.window.history.state).sort(), ['hermesMobile', 'page']);
  assert.ok(!JSON.stringify(p.window.history.state).includes('PRIVATE_DRAFT_MARKER'));
});

test('browser back cannot restore a previous profile or account DOM', async t => {
  const p = await page(t), main = p.window.document.querySelector('main');
  p.state.tab = 'tasks'; main.textContent = 'OLD_ACCOUNT_MARKER'; p.mobilePush();
  p.state.me = { authenticated: true, account_scope: 'other-owner' }; p.state.profile = 'other';
  p.mobileBack(); await settle();
  assert.equal(p.state.tab, 'home');
  assert.ok(!main.textContent.includes('OLD_ACCOUNT_MARKER'));
});

test('changing home mode through a child view renders the new mode on return', async t => {
  const p = await page(t);
  p.mobilePush(); p.window.document.querySelector('main').textContent = '首頁設定';
  p.state.homeMode = 'deep'; p.mobileBack(); await settle();
  assert.ok(p.window.document.querySelector('.home-hero.deep'));
});

test('closing a bottom sheet consumes one history entry without changing the source page', async t => {
  const p = await page(t), dialog = p.window.document.createElement('dialog');
  p.window.document.body.append(dialog); p.mobileDialog(dialog);
  assert.equal(dialog.open, true); assert.equal(p.window.history.state.page, 1);
  dialog.close(); await settle();
  assert.equal(p.window.history.state.page, 0);
  assert.equal(p.state.tab, 'home');
  assert.equal(p.window.document.querySelector('dialog[open]'), null);
});

test('closing a sheet and immediately opening its destination consumes no extra back step', async t => {
  const p = await page(t), first = p.window.document.createElement('dialog');
  p.window.document.body.append(first); p.mobileDialog(first);
  first.close(); p.mobilePush(); p.state.tab = 'tasks'; p.render();
  await settle();
  assert.equal(p.state.tab, 'tasks'); assert.equal(p.window.history.state.page, 1);
  p.mobileBack(); await settle(); assert.equal(p.state.tab, 'home');
});

test('replacing a sheet does not let the previous close event dismiss the new sheet', async t => {
  const p = await page(t), first = p.window.document.createElement('dialog'), second = p.window.document.createElement('dialog');
  p.window.document.body.append(first); p.mobileDialog(first); first.close();
  p.window.document.body.append(second); p.mobileDialog(second); await settle();
  assert.equal(second.open, true); assert.equal(p.window.history.state.page, 1);
  second.close(); await settle(); assert.equal(p.window.history.state.page, 0);
});

test('browser back keeps an unsaved sheet open until its dismissal guard allows it', async t => {
  const p = await page(t), dialog = p.window.document.createElement('dialog');
  let dirty = true; dialog._requestDismiss = () => !dirty;
  p.window.document.body.append(dialog); p.mobileDialog(dialog);
  p.mobileBack(); await settle(); assert.equal(dialog.open, true);
  p.window.history.back(); await settle(); assert.equal(dialog.open, true); assert.equal(p.window.history.state.page, 1);
  dirty = false; p.mobileBack(); await settle(); assert.equal(p.window.history.state.page, 0);
});

test('a sheet action preserves updated source state after asynchronous history cleanup', async t => {
  const p = await page(t), main = p.window.document.querySelector('main');
  p.state.tab = 'files'; p.state.showHiddenFiles = false; main.textContent = 'visible only';
  const dialog = p.window.document.createElement('dialog'); p.window.document.body.append(dialog); p.mobileDialog(dialog);
  dialog.close(); p.state.showHiddenFiles = true; main.textContent = 'hidden files now visible';
  await settle(); assert.equal(p.state.showHiddenFiles, true); assert.equal(main.textContent, 'hidden files now visible');
  assert.equal(p.window.history.state.page, 0);
});

test('closing a restored parent sheet consumes its remaining history entry', async t => {
  const p = await page(t), first = p.window.document.createElement('dialog'), second = p.window.document.createElement('dialog');
  p.window.document.body.append(first); p.mobileDialog(first);
  p.window.document.body.append(second); p.mobileDialog(second);
  assert.equal(p.window.history.state.page, 2);
  second.close(); await settle();
  assert.equal(first.open, true); assert.equal(p.window.history.state.page, 1);
  first.close(); await settle();
  assert.equal(p.window.history.state.page, 0);
});

test('mobile back dismisses the topmost nested sheet before its parent', async t => {
  const p = await page(t), first = p.window.document.createElement('dialog'), second = p.window.document.createElement('dialog');
  p.window.document.body.append(first); p.mobileDialog(first);
  p.window.document.body.append(second); p.mobileDialog(second);
  p.mobileBack(); await settle();
  assert.equal(second.open, false);
  assert.equal(first.open, true);
  assert.equal(p.window.history.state.page, 1);
});

test('queued native close events cannot remove a parent sheet restored by back', async t => {
  const p = await page(t), first = p.window.document.createElement('dialog'), second = p.window.document.createElement('dialog');
  // HTML dialog close events are queued; Happy DOM normally dispatches them synchronously.
  for (const dialog of [first, second]) dialog.close = () => {
    if (!dialog.open) return;
    dialog.removeAttribute('open');
    setTimeout(() => dialog.dispatchEvent(new p.window.Event('close')), 0);
  };
  p.window.document.body.append(first); p.mobileDialog(first);
  p.window.document.body.append(second); p.mobileDialog(second);
  second.close(); await settle();
  assert.equal(first.open, true);
  assert.equal(first.isConnected, true);
});
