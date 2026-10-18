const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Exercise the shipped renderers with isolated fake HTTP; no live gateway or account.
async function page(t) {
  const { Window } = await import('happy-dom');
  const window = new Window({ url: 'http://localhost/mobile/' });
  window.document.body.innerHTML = '<div class="brand-mark"></div><small id="connection-state"></small><main id="main"></main><nav id="dock"></nav><div id="notice"></div>';
  const requests = [];
  let response = () => ({ status: 200, body: {} });
  window.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), ...options });
    const result = await response(String(url), options);
    return new window.Response(JSON.stringify(result.body), { status: result.status || 200 });
  };
  const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
  window.eval(source.replace('  init();', '  window.testApp = {state, render, mobileReset, mobileBack, refreshFiles, openFile, switchTab};'));
  const app = window.testApp;
  Object.assign(app.state, { me: { authenticated: true, account_scope: 'fixture-owner', profiles: ['demo', 'other'] }, profile: 'demo' });
  app.mobileReset();
  t.after(() => window.happyDOM.abort());
  const main = window.document.querySelector('main');
  return { window, main, requests, ...app,
    respond: fn => { response = fn; },
    change: (selector, value) => {
      const input = main.querySelector(selector); assert.ok(input, selector);
      input.value = value; input.dispatchEvent(new window.Event('change', { bubbles: true }));
    },
    click: text => {
      const button = [...window.document.querySelectorAll('button')].find(node => (node.getAttribute('aria-label') || node.textContent) === text);
      assert.ok(button, `button: ${text}`); button.click();
    }
  };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 40));
const titles = p => [...p.main.querySelectorAll('.session-title-line strong')].map(node => node.textContent);

function sessions(p) {
  Object.assign(p.state, { tab: 'sessions', projects: [{ id: 'alpha', name: 'Alpha', primary_path: '/alpha' }], sessions: [
    { id: '1', title: '今天 Alpha', workspacePath: '/alpha', updated_at: new Date().toISOString() },
    { id: '2', title: '舊 Alpha', workspacePath: '/alpha', updated_at: '2000-01-01T00:00:00Z' },
    { id: '3', title: '其他', workspacePath: '/beta', updated_at: new Date().toISOString() },
  ] }); p.render();
}

test('M05 time and project filters intersect, search preserves those filters', async t => {
  const p = await page(t); sessions(p);
  p.change('[aria-label="依專案篩選"]', '/alpha');
  assert.deepEqual(titles(p), ['今天 Alpha', '舊 Alpha']);
  p.change('[aria-label="時間範圍"]', 'today');
  assert.deepEqual(titles(p), ['今天 Alpha']);
  const input = p.main.querySelector('input[aria-label="搜尋對話"]');
  input.value = '其他'; input.dispatchEvent(new p.window.Event('input'));
  assert.deepEqual(titles(p), []);
  assert.match(p.main.textContent, /沒有符合條件/);
  p.click('清除篩選');
  assert.equal(titles(p).length, 3);
  assert.equal(p.state.sessionProject, '');
  assert.equal(p.state.sessionTime, 'all');
});

test('M05 project mode groups matching and unclassified conversations', async t => {
  const p = await page(t); sessions(p);
  p.change('[aria-label="排列方式"]', 'projects');
  assert.deepEqual([...p.main.querySelectorAll('.group-label')].map(node => node.textContent), ['Alpha', '未分類專案']);
  assert.equal(p.main.querySelectorAll('.session-open').length, 3);
});

test('M06 cancelling rename leaves the original conversation untouched', async t => {
  const p = await page(t); sessions(p);
  p.main.querySelector('.ui-more').click(); p.click('重新命名'); await settle();
  const sheet = p.window.document.querySelector('dialog[open]');
  assert.ok(sheet, 'rename sheet must survive closing the actions sheet');
  assert.match(sheet.textContent, /儲存/);
  p.click('關閉'); await settle();
  assert.equal(p.requests.filter(request => request.method === 'PATCH').length, 0);
  assert.ok(titles(p).includes('今天 Alpha'));
});

test('M01 profile root stays compact with 80 available tools', async t => {
  const p = await page(t);
  Object.assign(p.state, { tab: 'me', inventory: { tools: { tools: Array.from({ length: 80 }, (_, index) => ({ name: `private-tool-${index}` })) } } }); p.render();
  assert.equal(p.main.querySelectorAll('.profile-link').length, 5);
  assert.ok(!p.main.textContent.includes('private-tool-'));
  assert.equal(p.main.querySelectorAll('input, textarea, select').length, 0);
});

test('M01 settings section shows only its matching forms', async t => {
  const p = await page(t);
  Object.assign(p.state, { tab: 'me', mePage: 'server-settings', settingsSection: 'approvals', settings: { settings: { approvals: { mode: 'ask', timeout: 30 } } } }); p.render();
  assert.deepEqual([...p.main.querySelectorAll('.card h2')].map(node => node.textContent), ['操作批准']);
});

test('Profile switch clears all previous-profile task content before requests finish', async t => {
  const p = await page(t);
  Object.assign(p.state, { tab: 'me', mePage: 'connection', activeRuns: [{ stored_session_id: 'old-run', profile: 'demo' }], taskSessions: [{ id: 'old-task', profile: 'demo' }], run: 'running' });
  p.respond(() => new Promise(() => {})); p.render();
  p.change('[aria-label="選擇 Profile"]', 'other');
  assert.equal(p.state.profile, 'other');
  assert.equal(p.state.activeRuns.length, 0);
  assert.equal(p.state.taskSessions.length, 0);
  assert.notEqual(p.state.run, 'running');
});

function files(p) {
  Object.assign(p.state, { tab: 'files', filePath: '/work', workspaceRoot: '/work', files: { path: '/work', parent: null, entries: [
    { name: '.env', path: '/work/.env', is_directory: false },
    { name: '中文資料夾', path: '/work/中文資料夾', is_directory: true },
    { name: 'readme.txt', path: '/work/readme.txt', is_directory: false },
  ] } }); p.render();
}

test('M07 hidden files toggle reveals dotfiles and retains regular entries', async t => {
  const p = await page(t); files(p);
  assert.ok(!p.main.textContent.includes('.env'));
  p.main.querySelector('.ui-more').click(); p.click('顯示隱藏與系統檔案'); await settle();
  assert.ok(p.main.textContent.includes('.env'));
  assert.ok(p.main.textContent.includes('readme.txt'));
});

test('M07 folder navigation creates a back entry and returns to parent listing', async t => {
  const p = await page(t); files(p);
  p.respond(() => ({ body: { path: '/work/中文資料夾', parent: '/work', entries: [] } }));
  p.main.querySelector('.folder-tile').click(); await settle();
  assert.equal(p.state.filePath, '/work/中文資料夾');
  assert.ok(p.window.history.state.page > 0, 'folder descent needs its own history entry');
  p.mobileBack(); await settle();
  assert.equal(p.state.tab, 'files');
  assert.equal(p.state.filePath, '/work');
});

test('M07 navigating up from a document closes the old document', async t => {
  const p = await page(t); files(p);
  p.state.document = { name: 'readme.txt', path: '/work/sub/readme.txt', data_url: 'data:text/plain;base64,aGk=' };
  p.respond(() => ({ body: { path: '/work', parent: null, entries: [] } }));
  await p.refreshFiles('/work');
  assert.equal(p.state.document, null);
  assert.equal(p.main.querySelector('[aria-label="檔案內容"]'), null);
});

test('M15 scheduled cards sort by next time and hide paused jobs until expanded', async t => {
  const p = await page(t);
  Object.assign(p.state, { tab: 'tasks', taskView: 'scheduled', cron: [
    { id: 'late', name: '晚一點', enabled: true, next_run_at: '2030-01-02T00:00:00Z' },
    { id: 'paused', name: '已停用任務', enabled: false },
    { id: 'soon', name: '早一點', enabled: true, next_run_at: '2030-01-01T00:00:00Z' },
  ] }); p.render();
  assert.deepEqual([...p.main.querySelectorAll('.cron-title')].map(node => node.textContent), ['早一點', '晚一點']);
  assert.equal(p.main.querySelectorAll('.cron-card .ui-more').length, 2);
  assert.ok(!p.main.textContent.includes('現在執行一次'));
  p.click('已暫停 · 1');
  assert.equal(p.main.querySelectorAll('.cron-card').length, 3);
});

test('M15 failed task toggle restores server state instead of showing a false pause', async t => {
  const p = await page(t);
  Object.assign(p.state, { tab: 'tasks', taskView: 'scheduled', cron: [{ id: 'one', name: '任務', enabled: true }] });
  p.respond(() => ({ status: 503, body: { detail: 'fixture unavailable' } })); p.render();
  const toggle = p.main.querySelector('[role="switch"]');
  toggle.checked = false; toggle.dispatchEvent(new p.window.Event('change')); await settle();
  assert.equal(toggle.checked, true);
  assert.equal(toggle.disabled, false);
  assert.equal(p.requests.filter(request => request.method === 'POST').length, 1);
});

test('M05 dock returns from archive to regular conversations', async t => {
  const p = await page(t); sessions(p); p.state.showArchived = true; p.render();
  p.respond(() => ({ body: { sessions: [] } }));
  [...p.window.document.querySelectorAll('#dock button')].find(node => node.textContent === '回看').click(); await settle();
  assert.equal(p.state.showArchived, false);
  assert.ok(p.requests.some(request => request.url.includes('/sessions?') && !request.url.includes('archived=only')));
});

test('M07 refreshing the same directory does not add a history entry', async t => {
  const p = await page(t); files(p);
  p.respond(() => ({ body: { path: '/work', parent: null, entries: [] } }));
  const before = p.window.history.state.page;
  await p.refreshFiles('/work');
  assert.equal(p.window.history.state.page, before);
});

test('M07 opening a file adds one entry, reading the same file back adds none', async t => {
  const p = await page(t); files(p);
  p.respond(() => ({ body: { path: '/work/readme.txt', data_url: 'data:text/plain;base64,aGk=' } }));
  await p.openFile({ path: '/work/readme.txt', name: 'readme.txt' });
  const afterOpen = p.window.history.state.page;
  assert.equal(afterOpen, 1);
  await p.openFile({ path: '/work/readme.txt', name: 'readme.txt' });
  assert.equal(p.window.history.state.page, afterOpen);
  p.mobileBack(); await settle();
  assert.equal(p.state.document, null);
  assert.equal(p.state.tab, 'files');
});

test('M15 failed readback after a task toggle is not presented as verified success', async t => {
  const p = await page(t);
  Object.assign(p.state, { tab: 'tasks', taskView: 'scheduled', cron: [{ id: 'one', name: '任務', enabled: true }] });
  p.respond((url, options) => options.method === 'POST' ? { body: { ok: true } } : { status: 503, body: { detail: 'readback unavailable' } }); p.render();
  const toggle = p.main.querySelector('[role="switch"]');
  toggle.checked = false; toggle.dispatchEvent(new p.window.Event('change')); await settle();
  assert.equal(toggle.checked, true);
  assert.match(p.window.document.querySelector('#notice').textContent, /readback unavailable/);
});

test('M15 task editor returns one level to scheduled cards without saving', async t => {
  const p = await page(t);
  Object.assign(p.state, { tab: 'tasks', taskView: 'scheduled', cron: [{ id: 'one', name: '保留任務', enabled: true }] }); p.render();
  p.click('新增定時任務');
  assert.equal(p.window.history.state.page, 1);
  assert.ok(p.main.querySelector('textarea'));
  p.click('返回'); await settle();
  assert.equal(p.window.history.state.page, 0);
  assert.equal(p.main.querySelector('.cron-title').textContent, '保留任務');
  assert.equal(p.requests.length, 0);
});

test('M15 task details and editor each consume only one back step', async t => {
  const p = await page(t);
  Object.assign(p.state, { tab: 'tasks', taskView: 'scheduled', cron: [{ id: 'one', name: '保留任務', enabled: true }] });
  p.respond(() => ({ body: { job: { id: 'one', name: '保留任務', prompt: '工作內容' } } })); p.render();
  p.main.querySelector('.cron-title').click(); await settle();
  assert.equal(p.window.history.state.page, 1);
  p.click('編輯');
  assert.equal(p.window.history.state.page, 2);
  p.click('返回'); await settle();
  assert.equal(p.window.history.state.page, 1);
  assert.ok([...p.main.querySelectorAll('button')].some(node => node.textContent === '返回任務'));
  p.click('返回任務'); await settle();
  assert.equal(p.window.history.state.page, 0);
  assert.ok(p.main.querySelector('.cron-card'));
});

test('M06 left swipe reveals archive and delete, vertical movement never opens actions', async t => {
  const p = await page(t); sessions(p);
  const open = p.main.querySelector('.session-open');
  const actions = p.main.querySelector('.swipe-actions');
  assert.equal(actions.inert, true);
  assert.equal(actions.getAttribute('aria-hidden'), 'true');
  const pointer = (type, x, y) => open.dispatchEvent(new p.window.PointerEvent(type, { button: 0, clientX: x, clientY: y }));
  pointer('pointerdown', 200, 100); pointer('pointermove', 190, 170); pointer('pointerup', 190, 170);
  assert.equal(p.main.querySelector('.session-front').style.transform, '');
  pointer('pointerdown', 200, 100); pointer('pointermove', 100, 101); pointer('pointerup', 100, 101);
  assert.equal(p.main.querySelector('.session-front').style.transform, 'translateX(-132px)');
  assert.equal(actions.inert, false);
  assert.equal(actions.getAttribute('aria-hidden'), 'false');
  assert.deepEqual([...p.main.querySelector('.swipe-actions').querySelectorAll('button')].map(node => node.textContent), ['封存', '刪除']);
  assert.equal(p.requests.length, 0);
});

test('M06 archive and delete require explicit confirmation, cancellation never writes', async t => {
  const p = await page(t); sessions(p);
  p.main.querySelector('.swipe-action').click(); await settle();
  assert.equal(p.requests.length, 0);
  p.click('取消'); await settle();
  assert.equal(p.requests.length, 0);
  p.main.querySelectorAll('.swipe-action')[1].click(); await settle();
  assert.equal(p.requests.length, 0);
  p.respond(() => ({ body: { sessions: [] } }));
  p.click('確認刪除對話'); await settle();
  assert.equal(p.requests.filter(request => request.method === 'DELETE').length, 1);
  assert.ok(p.requests.find(request => request.method === 'DELETE').url.includes('/sessions/1'));
});

test('M07 first directory load does not preserve an empty loading page in history', async t => {
  const p = await page(t);
  p.state.tab = 'files'; p.render();
  p.respond(() => ({ body: { path: '/work', parent: null, entries: [] } }));
  await p.refreshFiles();
  assert.equal(p.window.history.state.page, 0);
});

function styles(p) {
  const style = p.window.document.createElement('style');
  style.textContent = fs.readFileSync(path.join(__dirname, '../web/styles.css'), 'utf8');
  p.window.document.head.append(style);
}

test('settings switches stay beside their labels and never inherit full-width text field sizing', async t => {
  const p = await page(t); styles(p);
  Object.assign(p.state, { tab: 'me', mePage: 'server-settings', settingsSection: 'memory', settings: { settings: { memory: { memory_enabled: true } } } }); p.render();
  const input = p.main.querySelector('[aria-label="啟用記憶"]');
  assert.equal(input.getAttribute('role'), 'switch');
  assert.equal(input.closest('label').className, 'setting-switch-row');
  assert.equal(input.closest('.field'), null);
  const css = p.window.getComputedStyle(input);
  assert.equal(css.width, '52px');
  assert.equal(css.height, '32px');
  assert.equal(p.window.getComputedStyle(input.closest('label')).alignItems, 'center');
});

test('non-chat single-line controls share an explicit height while filters retain their compact Android size', async t => {
  const p = await page(t); styles(p);
  Object.assign(p.state, { tab: 'me', mePage: 'server-settings', settingsSection: 'approvals', settings: { settings: {} } }); p.render();
  for (const input of p.main.querySelectorAll('.field input')) assert.equal(p.window.getComputedStyle(input).minHeight, '56px');
  sessions(p);
  for (const input of p.main.querySelectorAll('.session-filter-selects select')) assert.equal(p.window.getComputedStyle(input).height, '40px');
});

test('task header actions keep Android sizes and cannot wrap onto separate lines', async t => {
  const p = await page(t); styles(p); p.state.tab = 'tasks'; p.render();
  assert.equal(p.window.getComputedStyle(p.main.querySelector('.task-refresh')).width, '38px');
  assert.equal(p.window.getComputedStyle(p.main.querySelector('.task-create')).width, '48px');
  assert.equal(p.window.getComputedStyle(p.main.querySelector('.page-head>.button-row')).flexWrap, 'nowrap');
});

test('edit profile and appearance are separate routes, with equal three-choice segments', async t => {
  const p = await page(t); styles(p); p.state.tab = 'me'; p.render();
  p.click('編輯資料');
  assert.equal(p.state.mePage, 'edit-profile');
  assert.ok(p.main.querySelector('input'));
  assert.equal(p.main.querySelector('.appearance-segments'), null);
  p.click('返回'); await settle();
  p.state.mePage = 'appearance'; p.render();
  assert.equal(p.main.querySelector('input'), null);
  const groups = p.main.querySelectorAll('.appearance-segments');
  assert.equal(groups.length, 2);
  for (const group of groups) {
    assert.equal(group.children.length, 3);
    assert.equal(group.querySelectorAll('[aria-pressed="true"]').length, 1);
    assert.equal(p.window.getComputedStyle(group).gridTemplateColumns, 'repeat(3,minmax(0,1fr))');
  }
  p.click('深色');
  assert.equal(p.main.querySelector('[aria-label="顯示模式"] [aria-pressed="true"]').textContent, '深色');
  p.click('紙本');
  assert.equal(p.main.querySelector('[aria-label="介面風格"] [aria-pressed="true"]').textContent, '紙本');
});

test('guide return consumes its history entry', async t => {
  const p = await page(t); p.state.tab = 'me'; p.render();
  p.main.querySelectorAll('.profile-link')[4].click();
  assert.equal(p.window.history.state.page, 1);
  p.click('返回'); await settle();
  assert.equal(p.window.history.state.page, 0);
  assert.equal(p.state.mePage, '');
});

test('archive settings navigation creates only one entry', async t => {
  const p = await page(t); p.state.tab = 'me'; p.state.mePage = 'settings'; p.render();
  p.respond(() => ({ body: { sessions: [] } }));
  [...p.main.querySelectorAll('.profile-link')].find(node => node.textContent.includes('已封存對話')).click(); await settle();
  assert.equal(p.window.history.state.page, 1);
  p.mobileBack(); await settle();
  assert.equal(p.state.tab, 'me');
  assert.equal(p.state.mePage, 'settings');
});

test('profile document return consumes its history entry without saving edits', async t => {
  const p = await page(t); p.state.tab = 'me'; p.render();
  p.respond(() => ({ body: { kind: 'memory', profile: 'demo', content: 'Original memory', exists: true } }));
  [...p.main.querySelectorAll('.profile-link')].find(node => node.textContent.includes('我的記憶')).click(); await settle();
  assert.equal(p.window.history.state.page, 1);
  assert.equal(p.state.mePage, 'memory');
  p.main.querySelector('textarea').value = 'Unsubmitted edit';
  p.click('返回'); await settle();
  assert.equal(p.window.history.state.page, 0);
  assert.equal(p.state.mePage, '');
  assert.equal(p.requests.filter(request => request.method === 'PUT').length, 0);
});
