const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function page(t) {
  const { Window } = await import('happy-dom');
  const window = new Window({ url: 'https://fixture.invalid/mobile/' });
  window.document.body.innerHTML = '<div class="app-shell"><main id="main"></main><nav id="dock"></nav></div><div id="notice"></div>';
  const viewport = new window.EventTarget();
  Object.assign(viewport, { height: 844, offsetTop: 0 });
  Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
  const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
  window.eval(source.replace('  init();', '  window.testChat = {state, render, draftFor};'));
  const app = window.testChat;
  Object.assign(app.state, { me: { authenticated: true, account_scope: 'viewport-test' }, profile: 'demo', tab: 'chat',
    selected: { id: 'test', runtimeId: 'test-runtime', profile: 'demo', fresh: true }, wsReady: true });
  app.render();
  const input = window.document.querySelector('.composer textarea');
  input.value = '未送出的中文草稿'; input.dispatchEvent(new window.Event('input'));
  input.focus(); input.setSelectionRange(3, 6);
  const feed = window.document.querySelector('.chat-scroll'); feed.scrollTop = 240;
  t.after(() => window.happyDOM.abort());
  return { window, viewport, input, feed, app, style: window.document.documentElement.style };
}

test('keyboard pan without resize tracks the visual viewport and preserves draft, selection and history', async t => {
  const p = await page(t);
  p.viewport.height = 420; p.viewport.dispatchEvent(new p.window.Event('resize'));
  p.viewport.offsetTop = 212; p.viewport.dispatchEvent(new p.window.Event('scroll'));
  assert.equal(p.style.getPropertyValue('--chat-height'), '420px');
  assert.equal(p.style.getPropertyValue('--chat-top'), '212px');
  assert.equal(p.window.document.querySelector('.composer textarea'), p.input);
  assert.equal(p.input.value, '未送出的中文草稿');
  assert.equal(p.app.draftFor(p.app.state.selected), p.input.value);
  assert.equal(p.input.selectionStart, 3); assert.equal(p.input.selectionEnd, 6);
  assert.equal(p.window.document.activeElement, p.input);
  assert.equal(p.feed.scrollTop, 240);
});

test('keyboard dismissal and rotation reset both viewport height and offset', async t => {
  const p = await page(t);
  Object.assign(p.viewport, { height: 420, offsetTop: 212 }); p.viewport.dispatchEvent(new p.window.Event('resize'));
  Object.assign(p.viewport, { height: 844, offsetTop: 0 }); p.viewport.dispatchEvent(new p.window.Event('resize'));
  assert.equal(p.style.getPropertyValue('--chat-height'), '844px');
  assert.equal(p.style.getPropertyValue('--chat-top'), '0px');
  Object.assign(p.viewport, { height: 390, offsetTop: 0 }); p.viewport.dispatchEvent(new p.window.Event('resize'));
  assert.equal(p.style.getPropertyValue('--chat-height'), '390px');
  assert.equal(p.feed.scrollTop, 240);
});

test('restoring a suspended page refreshes stale viewport geometry', async t => {
  const p = await page(t);
  Object.assign(p.viewport, { height: 420, offsetTop: 180 });
  p.window.dispatchEvent(new p.window.Event('pageshow'));
  assert.equal(p.style.getPropertyValue('--chat-height'), '420px');
  assert.equal(p.style.getPropertyValue('--chat-top'), '180px');
});
