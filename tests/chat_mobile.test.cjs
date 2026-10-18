const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
async function fixture() {
  const { Window } = await import('happy-dom');
  const window = new Window({ url: 'https://fixture.invalid/mobile/' });
  window.document.body.innerHTML = '<main id="main"></main><nav id="dock"></nav><div id="notice"></div><span class="brand-mark"></span>';
  let source = fs.readFileSync(process.env.CHAT_APP || path.join(__dirname, '../web/app.js'), 'utf8');
  source = source.replace(/  init\(\);\s*\}\)\(\);\s*$/, `  window.chatTest = { state, render, updateChat, updateComposer, showDecision, requestDraftKey, startSpeech, queueCurrentMessage, drainQueuedMessage, steerCurrentRun, showModelPicker, showComposerTools, handleEvent, saveDraft, draftFor,
    setRPC: fn => rpc = fn, setAPI: fn => api = fn, setNative: fn => nativeCall = fn };\n})();`);
  window.eval(source);
  const api = window.chatTest;
  Object.assign(api.state, { me: { authenticated: true, account_scope: 'fixture' }, profile: 'p', tab: 'chat',
    selected: { id: 'a', runtimeId: 'run-a', profile: 'p', fresh: true }, wsReady: true });
  const calls = [];
  api.setRPC(async (method, params) => { calls.push({ method, params }); return {}; });
  api.render();
  return { window, api, calls, close: () => window.happyDOM.abort() };
}
test('composer expands, switches primary action, and exposes live recording stop', async () => {
  const f = await fixture(); const { window: w, api } = f;
  try {
    assert.equal(w.document.querySelector('.chat-send').getAttribute('aria-label'), '語音輸入');
    const input = w.document.querySelector('textarea'); input.value = '訊息'; input.dispatchEvent(new w.Event('input'));
    assert.equal(w.document.querySelector('.chat-send').getAttribute('aria-label'), '送出');
    api.state.recorder = { stop() {} }; api.updateComposer();
    assert.match(w.document.querySelector('.voice-state').textContent, /完成錄音/);
    api.state.run = 'running'; api.updateComposer();
    assert.equal(w.document.querySelector('.chat-send').getAttribute('aria-label'), '停止');
    assert.equal(w.document.querySelector('.running-actions').hidden, false);
  } finally { await f.close(); }
});
test('decision closes without auto reopening; runtime replacement preserves draft key', async () => {
  const f = await fixture(); const { window: w, api } = f;
  try {
    const request = { key: 'q', conversationId: 'a', runtimeId: 'run-a', profile: 'p', type: 'clarify', title: '選擇', choices: ['A', 'B'], questionId: '1', serverId: 's' };
    api.state.pending.set('q', request); api.updateChat();
    assert.equal(w.document.querySelectorAll('dialog[open]').length, 1);
    w.document.querySelector('dialog').close(); await new Promise(r => setTimeout(r, 0)); api.updateChat();
    assert.equal(w.document.querySelectorAll('dialog[open]').length, 0);
    assert.equal(api.requestDraftKey(request), api.requestDraftKey({ ...request, runtimeId: 'new-runtime' }));
    api.showDecision(request); assert.equal(w.document.querySelectorAll('dialog[open]').length, 1);
  } finally { await f.close(); }
});
test('late native speech writes only original conversation draft', async () => {
  const f = await fixture(); const { window: w, api } = f;
  try {
    w.HermesNative = { postMessage() {} };
    let resolve; api.setNative(() => new Promise(r => resolve = r));
    const origin = { ...api.state.selected }; api.saveDraft(origin, '原稿');
    const task = api.startSpeech(w.document.querySelector('textarea'));
    api.state.selected = { id: 'b', runtimeId: 'run-b', profile: 'p' }; api.saveDraft(api.state.selected, 'B稿');
    resolve({ text: '語音結果' }); await task;
    assert.equal(api.draftFor(origin), '原稿\n語音結果');
    assert.equal(api.draftFor(api.state.selected), 'B稿');
  } finally { await f.close(); }
});
test('steering preserves newer draft typed during acknowledgement', async () => {
  const f = await fixture(); const { api } = f;
  try {
    api.state.run = 'running'; api.saveDraft(api.state.selected, '追加');
    let resolve; api.setRPC((method, params) => { assert.equal(method, 'session.steer'); assert.equal(params.profile, 'p'); return new Promise(r => resolve = r); });
    const task = api.steerCurrentRun(); api.saveDraft(api.state.selected, '新的草稿'); resolve({ status: 'queued' }); await task;
    assert.equal(api.draftFor(api.state.selected), '新的草稿');
  } finally { await f.close(); }
});
test('queued message drains once and retains later draft instead of overwriting', async () => {
  const f = await fixture(); const { api, calls } = f;
  try {
    api.state.run = 'running'; api.saveDraft(api.state.selected, '排隊'); api.queueCurrentMessage();
    api.state.run = 'idle'; api.saveDraft(api.state.selected, '稍後寫的'); await api.drainQueuedMessage(api.state.selected);
    assert.equal(calls.length, 0); assert.equal(api.draftFor(api.state.selected), '稍後寫的');
    api.saveDraft(api.state.selected, ''); api.setAPI(async () => ({}));
    await Promise.all([api.drainQueuedMessage(api.state.selected), api.drainQueuedMessage(api.state.selected)]);
    assert.equal(calls.filter(c => c.method === 'prompt.submit').length, 1);
    assert.equal(api.state.queuedMessages.size, 0);
  } finally { await f.close(); }
});
test('model picker filters and prevents concurrent switching', async () => {
  const f = await fixture(); const { window: w, api } = f;
  try {
    api.setAPI(async () => ({ providers: [{ slug: 'p', name: 'Provider', models: ['alpha', 'beta'] }] }));
    let resolve;
    api.setRPC((method) => method === 'session.resume' ? new Promise(r => resolve = r) : Promise.resolve({}));
    await api.showModelPicker();
    const search = w.document.querySelector('input[type="search"]'); search.value = 'beta'; search.dispatchEvent(new w.Event('input'));
    assert.equal(w.document.querySelectorAll('.model-choice').length, 1);
    w.document.querySelector('.model-choice').click();
    assert.equal(api.state.modelSwitching, true); assert.equal(w.document.querySelector('.model-choice').disabled, true);
    resolve({ session_id: 'run-a', running: true }); await new Promise(r => setTimeout(r, 10));
    assert.equal(api.state.modelSwitching, false);
  } finally { await f.close(); }
});

test('queuing immediately collapses cleared input and removes empty running actions', async () => {
  const f = await fixture(); const { window: w, api } = f;
  try {
    api.state.run = 'running'; const input = w.document.querySelector('textarea');
    input.value = 'queue test'; input.dispatchEvent(new w.Event('input'));
    api.queueCurrentMessage();
    assert.equal(input.value, '');
    assert.equal(w.document.querySelector('.running-actions').hidden, true);
    api.state.run = 'idle'; api.updateChat();
    assert.equal(w.document.querySelector('.chat-send').getAttribute('aria-label'), '語音輸入');
  } finally { await f.close(); }
});
