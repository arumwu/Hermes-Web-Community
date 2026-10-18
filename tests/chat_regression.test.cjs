const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
async function fixture() {
  const { Window } = await import('happy-dom');
  const window = new Window({ url: 'https://fixture.invalid/mobile/' });
  window.document.body.innerHTML = '<main id="main"></main><nav id="dock"></nav><div id="notice"></div><span class="brand-mark"></span>';
  let source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
  source = source.replace(/  init\(\);\s*\}\)\(\);\s*$/, `  window.chatTest = { state, render, updateChat, showChatOptions, showComposerTools, showCommandPalette, requestCard, recheckDecision, dismissDecisionReminder, canDismissDecision, mergeRequests, startSpeech, handleEvent, submitBackgroundQueue, recoverSession, mobileReset, saveDraft, draftFor, scopedSessionKey,
    setRPC: fn => rpc = fn, setAPI: fn => api = fn, setNative: fn => nativeCall = fn };\n})();`);
  window.eval(source);
  const api = window.chatTest;
  Object.assign(api.state, { me: { authenticated: true, account_scope: 'fixture' }, profile: 'p', tab: 'chat',
    selected: { id: 'b', runtimeId: 'run-b', profile: 'p', fresh: true }, wsReady: true });
  const calls = [];
  api.setRPC(async (method, params) => { calls.push({ method, params }); return { session_id: params.session_id, open_requests: [], running: false }; });
  api.setAPI(async () => ({}));
  api.mobileReset(); api.render();
  return { window, api, calls, close: () => window.happyDOM.abort() };
}
const tick = () => new Promise(r => setTimeout(r, 20));
function queuedFor(api) {
  const queued = { session: { id: 'a', runtimeId: 'run-a', profile: 'p', fresh: false }, prompt: '排隊工作', files: [], ready: true };
  api.state.queuedMessages.set('p::a', queued);
  return queued;
}
test('background queue does not resubmit an uncertain delivery on duplicate completion', async () => {
  const f = await fixture();
  try {
    const queued = queuedFor(f.api); let submits = 0;
    f.api.setRPC(async (method) => { if (method === 'prompt.submit') { submits++; throw new Error('timeout'); } return { session_id: 'run-a', running: false }; });
    await f.api.submitBackgroundQueue(queued);
    assert.equal(queued.uncertain, true);
    f.api.handleEvent({ type: 'message.complete', session_id: 'run-a', payload: { profile: 'p', status: 'completed' } });
    await tick();
    assert.equal(submits, 1, 'uncertain delivery must be reconciled instead of submitted again');
  } finally { await f.close(); }
});
test('accepted background delivery is removed after returning to original conversation', async () => {
  const f = await fixture();
  try {
    const queued = queuedFor(f.api); queued.uncertain = true; queued.submissionId = 'delivery-a';
    f.api.state.turnAttempts.set('p::a', { id: 'delivery-a', draft: queued.prompt });
    f.api.state.selected = queued.session;
    f.api.setRPC(async () => ({ session_id: 'run-a', open_requests: [], running: false }));
    f.api.setAPI(async url => url.startsWith('/deliveries/') ? { state: 'accepted' } : {});
    await f.api.recoverSession(false);
    assert.equal(f.api.state.queuedMessages.has('p::a'), false, 'accepted queued item must not remain uncertain forever');
    assert.equal(f.api.state.turnAttempts.size, 0);
  } finally { await f.close(); }
});
test('background queue checks profile before any RPC and after resume', async () => {
  const f = await fixture();
  try {
    const queued = queuedFor(f.api); f.api.state.profile = 'other';
    await f.api.submitBackgroundQueue(queued); assert.equal(f.calls.length, 0);
    f.api.state.profile = 'p'; queued.session.workspacePath = '/work'; let finish; const methods = [];
    f.api.setRPC((method) => { methods.push(method); return new Promise(r => finish = r); });
    const work = f.api.submitBackgroundQueue(queued);
    f.api.state.profile = 'other'; finish({ session_id: 'run-a', running: false }); await work;
    assert.deepEqual(methods, ['session.resume']);
  } finally { await f.close(); }
});
test('opening model from options keeps the model sheet usable after history settles', async () => {
  const f = await fixture();
  try {
    f.api.setAPI(async () => ({ providers: [{ slug: 'p', models: ['alpha'] }] }));
    f.api.showChatOptions();
    [...f.window.document.querySelectorAll('dialog button')].find(b => b.querySelector('strong')?.textContent === '模型').click();
    await tick();
    assert.equal(f.window.document.querySelectorAll('dialog[open]').length, 1);
    assert.equal(f.window.document.querySelector('dialog[open]').getAttribute('aria-label'), '切換模型');
    assert.equal(f.window.document.querySelectorAll('.model-choice').length, 1);
  } finally { await f.close(); }
});
test('rejected background delivery keeps attachments queued for deliberate retry', async () => {
  const f = await fixture();
  try {
    const queued = queuedFor(f.api); queued.uncertain = true; queued.submissionId = 'delivery-a';
    queued.files = [new f.window.File(['photo'], 'photo.png', { type: 'image/png' })];
    f.api.state.turnAttempts.set('p::a', { id: 'delivery-a', draft: queued.prompt });
    f.api.state.selected = queued.session;
    f.api.setRPC(async () => ({ session_id: 'run-a', open_requests: [], running: false }));
    f.api.setAPI(async url => url.startsWith('/deliveries/') ? { state: 'rejected' } : {});
    await f.api.recoverSession(false);
    assert.equal(f.api.state.queuedMessages.get('p::a'), queued);
    assert.equal(queued.uncertain, false); assert.equal(queued.ready, true);
    assert.equal(queued.files.length, 1); assert.equal(f.api.state.turnAttempts.size, 0);
  } finally { await f.close(); }
});
test('completion preserves uncertain queued receipt until reconciliation', async () => {
  const f = await fixture();
  try {
    const queued = queuedFor(f.api); queued.uncertain = true; queued.submissionId = 'delivery-a';
    f.api.state.turnAttempts.set('p::a', { id: 'delivery-a', draft: queued.prompt });
    f.api.state.selected = queued.session;
    f.api.render();
    f.api.handleEvent({ type: 'message.complete', session_id: 'run-a', payload: { profile: 'p', status: 'completed' } });
    await tick();
    assert.equal(f.api.state.turnAttempts.get('p::a').id, 'delivery-a');
    assert.equal(f.calls.filter(c => c.method === 'prompt.submit').length, 0);
  } finally { await f.close(); }
});
test('late native transcript cannot be written into a newly logged in account', async () => {
  const f = await fixture();
  try {
    f.window.HermesNative = { postMessage() {} }; let finish;
    f.api.setNative(() => new Promise(r => finish = r));
    const original = f.api.state.selected;
    const work = f.api.startSpeech(f.window.document.querySelector('textarea'));
    f.api.state.me = { authenticated: true, account_scope: 'new-account' };
    finish({ text: '上一個帳號的語音' }); await work;
    assert.equal(f.api.draftFor(original), '');
  } finally { await f.close(); }
});
test('events with the same runtime id but another profile do not mutate the visible chat', async () => {
  const f = await fixture();
  try {
    f.api.state.run = 'idle';
    f.api.handleEvent({ type: 'message.start', session_id: 'run-b', payload: { profile: 'other' } });
    assert.equal(f.api.state.run, 'idle');
    f.api.handleEvent({ type: 'session.info', session_id: 'run-b', payload: { profile: 'other', model: 'wrong-model' } });
    assert.notEqual(f.api.state.selected.model, 'wrong-model');
  } finally { await f.close(); }
});
test('concurrent background completion handling sends only one prompt', async () => {
  const f = await fixture();
  try {
    const queued = queuedFor(f.api); let finish; let submits = 0;
    f.api.setRPC(async method => { if (method === 'prompt.submit') { submits++; return new Promise(r => finish = r); } return { session_id: 'run-a', running: false }; });
    const first = f.api.submitBackgroundQueue(queued);
    await tick();
    await f.api.submitBackgroundQueue(queued);
    assert.equal(submits, 1); finish({}); await first;
    assert.equal(f.api.state.queuedMessages.size, 0);
  } finally { await f.close(); }
});
test('reconnect to an idle session exposes queued work without automatically resending', async () => {
  const f = await fixture();
  try {
    const queued = queuedFor(f.api); queued.ready = false;
    f.api.state.selected = queued.session;
    await f.api.recoverSession(false);
    assert.equal(queued.ready, true);
    assert.equal(f.calls.filter(c => c.method === 'prompt.submit').length, 0);
  } finally { await f.close(); }
});
test('composer tools offer four tiles and reorderable default snippets', async () => {
  const f = await fixture();
  try {
    f.api.showComposerTools(f.window.document.createElement('input'));
    const d = f.window.document.querySelector('dialog[open]');
    assert.equal(d.querySelectorAll('.composer-tool-tile').length, 4);
    assert.equal(d.querySelectorAll('.snippet-entry').length, 3);
    [...d.querySelectorAll('button')].find(b => b.textContent === '管理').click();
    const firstTitle = d.querySelector('.snippet-manage strong').textContent;
    [...d.querySelectorAll('.snippet-manage button')].find(b => b.textContent === '下移').click();
    assert.notEqual(d.querySelector('.snippet-manage strong').textContent, firstTitle);
    assert.equal(d.querySelectorAll('.snippet-manage strong')[1].textContent, firstTitle);
  } finally { await f.close(); }
});
test('unsaved snippet dismissal stays in the same dialog and preserves editor input', async () => {
  const f = await fixture();
  try {
    f.api.showComposerTools(f.window.document.createElement('input'));
    const d = f.window.document.querySelector('dialog[open]');
    const click = label => [...d.querySelectorAll('button')].find(b => b.textContent === label).click();
    click('管理'); click('新增片段');
    const title = d.querySelector('input'), body = d.querySelector('textarea');
    title.value = '未儲存'; body.value = '編輯中的內容';
    assert.equal(d._requestDismiss(), false);
    assert.equal(f.window.document.querySelectorAll('dialog').length, 1);
    click('繼續編輯');
    assert.equal(d.querySelector('input'), title); assert.equal(d.querySelector('textarea').value, '編輯中的內容');
    assert.equal(d._requestDismiss(), false); click('放棄修改');
    assert.equal(d.open, false);
  } finally { await f.close(); }
});
test('decision keeps actions outside scroll content and shows choice descriptions', async () => {
  const f = await fixture();
  try {
    const request = { key: 'detail', conversationId: 'b', runtimeId: 'run-b', profile: 'p', type: 'clarify', title: '選擇', choices: [{ value: 'one', label: '一次', description: '只執行這次' }], questionId: '1', serverId: 's' };
    const card = f.api.requestCard(request, true);
    assert.equal(card.querySelector('.decision-content .decision-footer'), null);
    assert.equal(card.querySelector('.decision-footer').parentElement, card);
    assert.match(card.querySelector('.request-choice').textContent, /只執行這次/);
    assert.equal(card.querySelector('textarea'), null);
    const multiple = f.api.requestCard({ ...request, multiSelect: true }, true);
    assert.ok(multiple.querySelector('textarea'));
    assert.equal(multiple.querySelector('input').type, 'checkbox');
  } finally { await f.close(); }
});
test('command catalog accepts the Android object text field inside categories', async () => {
  const f = await fixture();
  try {
    f.api.setRPC(async () => ({ categories: [{ name: '基本', commands: [{ text: '/help', description: '顯示說明' }] }] }));
    await f.api.showCommandPalette();
    const choice = [...f.window.document.querySelectorAll('dialog .stack button')].find(b => b.textContent.includes('/help'));
    assert.ok(choice, 'Android accepts text/command/name/value/display command fields');
    choice.click();
    assert.equal(f.api.draftFor(f.api.state.selected), '/help ');
  } finally { await f.close(); }
});
test('known context attachments fold without removing them or hiding arbitrary JSON files', async () => {
  const f = await fixture();
  try {
    f.api.state.attachments = [new f.window.File(['context'], 'hermes-today-contract.md'), new f.window.File(['{}'], 'user.json')];
    f.api.updateChat();
    const toggle = f.window.document.querySelector('.attachment-context-toggle');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(f.window.document.querySelectorAll('.attachment-chip').length, 1);
    assert.match(f.window.document.querySelector('.attachment-preview').textContent, /user.json/);
    assert.equal(f.api.state.attachments.length, 2);
    toggle.click(); assert.equal(f.window.document.querySelectorAll('.attachment-chip').length, 2);
    f.window.document.querySelector('.attachment-remove').click();
    assert.equal(f.api.state.attachments.length, 1); assert.equal(f.api.state.attachments[0].name, 'user.json');
  } finally { await f.close(); }
});
test('same-name files remain identifiable and non-image preview shows metadata without executing content', async () => {
  const f = await fixture();
  try {
    f.api.state.attachments = [new f.window.File(['<script>window.pwned=true</script>'], 'same.html', { type: 'text/html' }), new f.window.File(['second'], 'same.html', { type: 'text/html' })];
    f.api.updateChat();
    const previews = [...f.window.document.querySelectorAll('.attachment-preview')];
    assert.notEqual(previews[0].textContent, previews[1].textContent);
    assert.match(previews[0].textContent, /1\. same.html/); assert.match(previews[1].textContent, /2\. same.html/);
    assert.equal(previews[0].disabled, false); previews[0].click();
    const detail = f.window.document.querySelector('.attachment-detail');
    assert.equal(detail.querySelector('.attachment-full-name').textContent, 'same.html');
    assert.match(detail.textContent, /text\/html/); assert.match(detail.textContent, /bytes/);
    assert.equal(detail.querySelector('iframe,script,object,embed'), null);
    assert.equal(f.window.pwned, undefined); assert.equal(f.api.state.attachments.length, 2);
  } finally { await f.close(); }
});
function pendingDecision(f) {
  const request = { key: 'approval-1', conversationId: 'b', runtimeId: 'run-b', profile: 'p', type: 'approval', title: '執行操作', details: '確認範圍', choices: ['once', 'deny'], serverId: 'approval-1', questionId: '' };
  f.api.state.pending.set(request.key, request); f.api.requestCard(request, true); return request;
}
test('offline unknown request requires explicit local-removal confirmation and sends no RPC', async () => {
  const f = await fixture();
  try {
    const request = pendingDecision(f); f.api.state.wsReady = false;
    await f.api.recheckDecision(request);
    assert.equal(f.api.canDismissDecision(request), true);
    f.api.dismissDecisionReminder(request);
    assert.equal(f.api.state.pending.has(request.key), true);
    const confirm = f.window.document.querySelector('dialog[aria-label="移除此提醒？"]');
    assert.match(confirm.textContent, /僅移除此裝置提醒，伺服器不變/);
    [...confirm.querySelectorAll('button')].find(b => b.textContent === '確認移除提醒').click();
    assert.equal(f.api.state.pending.has(request.key), false);
    assert.equal(f.calls.length, 0);
    f.api.mergeRequests([{ request_id: request.key, type: 'approval', title: request.title, description: request.details, choices: request.choices, server_request_id: request.serverId }], 'run-b');
    assert.equal(f.api.state.pending.has(request.key), true, 'a later authoritative active request must reappear');
  } finally { await f.close(); }
});
test('active snapshot revokes local-removal eligibility, empty snapshot removes automatically', async () => {
  const f = await fixture();
  try {
    const request = pendingDecision(f);
    f.api.setRPC(async () => ({})); await f.api.recheckDecision(request);
    assert.equal(f.api.canDismissDecision(request), true);
    f.api.setRPC(async () => ({ open_requests: [{ request_id: request.key, type: 'approval', title: request.title, description: request.details, choices: request.choices, server_request_id: request.serverId }] }));
    await f.api.recheckDecision(request); assert.equal(f.api.canDismissDecision(request), false);
    assert.equal(f.api.state.pending.has(request.key), true);
    f.api.setRPC(async () => ({ open_requests: [] })); await f.api.recheckDecision(request);
    assert.equal(f.api.state.pending.has(request.key), false);
  } finally { await f.close(); }
});
test('local reminder confirmation becomes invalid after scope or request-content changes', async () => {
  const f = await fixture();
  try {
    const request = pendingDecision(f); f.api.state.wsReady = false;
    await f.api.recheckDecision(request); assert.equal(f.api.canDismissDecision(request), true);
    f.api.state.ws = {}; assert.equal(f.api.canDismissDecision(request), false);
    f.api.state.ws = null; f.api.state.pending.set(request.key, { ...request, details: '新的操作內容' });
    assert.equal(f.api.canDismissDecision(request), false);
    f.api.state.pending.set(request.key, request); f.api.state.me.account_scope = 'other';
    assert.equal(f.api.canDismissDecision(request), false);
  } finally { await f.close(); }
});
