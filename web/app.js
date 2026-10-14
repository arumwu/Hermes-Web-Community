/* Original mobile client. Data from Hermes is rendered as text, never HTML. */
(() => {
  'use strict';
  function scopedSessionKey(session, fallbackProfile) {
    const profile = session?.profile || fallbackProfile;
    if (!profile || !session?.id) throw new Error('會話範圍不完整');
    return `${profile}::${session.id}`;
  }
  function legacyRequestParams(request, answer) {
    if (!request?.runtimeId || !request?.key || !request?.profile) throw new Error('待確認事項已失去會話範圍');
    const common = { session_id: request.runtimeId, request_id: request.key, profile: request.profile };
    return request.type.includes('approval') ? { ...common, choice: answer } : { ...common, answer };
  }
  function canSubmitTurn(run, sendAttempted, session, activeProfile) {
    return Boolean(session?.id && session?.profile === activeProfile && !sendAttempted && run === 'idle');
  }
  function isPdfBytes(bytes) {
    return bytes?.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
  }
  function squareCropGeometry(width, height, zoom, offsetX = 0, offsetY = 0, output = 256) {
    if (!(width > 0 && height > 0 && width * height <= 32000000 && zoom >= 1 && zoom <= 3))
      throw new Error('照片尺寸或縮放不正確');
    const scale = Math.max(output / width, output / height) * zoom;
    const drawWidth = width * scale, drawHeight = height * scale;
    const x = (output - drawWidth) / 2 + Math.max((output - drawWidth) / 2, Math.min((drawWidth - output) / 2, offsetX));
    const y = (output - drawHeight) / 2 + Math.max((output - drawHeight) / 2, Math.min((drawHeight - output) / 2, offsetY));
    return { x, y, drawWidth, drawHeight };
  }
  function persistAvatarPhoto(storage, encoded) {
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(encoded || '') || encoded.length > 350000)
      throw new Error('裁切後的照片太大，未覆寫原頭像。');
    storage.setItem('hermes-web:avatar-photo', encoded);
  }
  function safeLink(value) {
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; }
    catch { return null; }
  }
  function parseProviderModelLines(value) {
    return String(value || '').split('\n').map(line => line.trim()).filter(Boolean).map(line => {
      const slash = line.indexOf('/');
      if (slash < 1 || slash === line.length - 1) throw new Error('模型格式請用 provider/model，每行一個。');
      const provider = line.slice(0, slash).trim(), model = line.slice(slash + 1).trim();
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(provider) || !model || model.length > 180) throw new Error('模型格式不正確。');
      return { provider, model };
    });
  }
  function parseMoASpecLines(value) {
    return String(value || '').split('\n').map(line => line.trim()).filter(Boolean).map(line => {
      const colon = line.indexOf(':');
      if (colon < 1 || colon === line.length - 1 || !/^[a-zA-Z0-9_-]{1,64}$/.test(line.slice(0, colon)))
        throw new Error('MoA 模型格式請用 provider:model，每行一個。');
      return line;
    });
  }
  function confirmedTodayReceipt(receipt, operation) {
    return Boolean(receipt?.confirmed === true && operation?.operation_id &&
      receipt.operation_id === operation.operation_id && receipt.mode === operation.mode &&
      (!operation.card_id || receipt.card_id === operation.card_id));
  }
  function patchMatches(actual, patch) {
    if (Array.isArray(patch)) return Array.isArray(actual) && patch.length === actual.length &&
      patch.every((item, index) => patchMatches(actual[index], item));
    if (patch && typeof patch === 'object') return actual && typeof actual === 'object' &&
      Object.entries(patch).every(([key, value]) => patchMatches(actual[key], value));
    return actual === patch;
  }
  function shareStorageKey(accountScope, profile, id) {
    if (!/^[a-f0-9]{64}$/.test(accountScope || '') || !/^[a-zA-Z0-9_-]{1,64}$/.test(profile || '') ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(id || '')) throw new Error('分享範圍不完整');
    return `${accountScope}:${profile}:${id}`;
  }
  const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const REASONING_LABELS = { none: '不啟用', minimal: '最少', low: '低', medium: '中', high: '高',
    xhigh: '很高', max: '最大', ultra: '極致' };
  function reasoningValue(value) {
    if (value === false || value?.enabled === false) return 'none';
    return typeof value === 'object' && value ? value.effort || '' : String(value ?? '');
  }
  function reasoningChoices(catalog, session) {
    const provider = (catalog.providers || []).find(row => row.slug === session.provider);
    const capability = provider?.capabilities?.[session.model];
    if (!provider || capability?.reasoning === false) return [];
    const levels = Array.isArray(catalog.reasoning_levels) ? catalog.reasoning_levels : REASONING_LEVELS;
    return levels.filter(value => REASONING_LEVELS.includes(value) &&
      (value !== 'none' || capability?.can_disable_reasoning !== false));
  }
  function selectionFromInfo(session, result, effort) {
    const info = result.info || {};
    return { ...session, runtimeId: result.session_id || session.runtimeId,
      model: info.model || session.model, provider: info.provider || session.provider,
      reasoningEffort: effort ?? info.reasoning_effort ?? session.reasoningEffort,
      reasoningEffortWire: info.reasoning_effort_wire || '' };
  }
  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined') module.exports = { scopedSessionKey, legacyRequestParams, canSubmitTurn,
      isPdfBytes, squareCropGeometry, persistAvatarPhoto, safeLink, parseProviderModelLines, parseMoASpecLines, confirmedTodayReceipt, patchMatches, shareStorageKey, reasoningChoices, selectionFromInfo, reasoningValue };
    return;
  }
  const $ = selector => document.querySelector(selector);
  const main = $('#main');
  const dock = $('#dock');
  const noticeNode = $('#notice');
  const tabs = [
    ['home', '助理', 'home'], ['sessions', '回看', 'history'], ['tasks', '任務', 'tasks'],
    ['files', '文件', 'files'], ['me', '我的', 'profile'],
  ];
  const state = {
    me: null, csrf: '', profile: 'default', tab: 'home', sessions: [], sessionOffset: 0,
    sessionsMore: false, showArchived: false, sessionProject: '', messageOffset: 0, selected: null,
    messages: [], models: null, cron: [], files: null, filePath: '', document: null,
    projects: [], pending: new Map(), toolCards: [], streamed: '', run: 'idle',
    sendAttempted: false, attachments: [], ws: null, wsReady: false, rpcCalls: new Map(),
    requestSerial: 0, connection: '連線中', lastError: '', homeMode: 'simple', today: null,
    inventory: null, mePage: '', settings: null, nickname: '', avatar: '☾', avatarPhoto: '', skin: 'glass', taskView: 'current', taskSessions: [],
    todayOperation: null, activeRuns: [], activeRunsComplete: false,
    sttMode: 'device', ttsMode: 'device', recorder: null, speechAudio: null,
    shareInbox: [], shareDraftIds: [], requestDrafts: new Map(), turnAttempts: new Map(),
    protocolReady: false, capabilityPromise: null, streamStarted: false, reasoning: '',
  };
  let noticeTimer;
  let updateSerial = 0;
  let activePdfURL = null;
  let activeAvatarURL = null;
  if (window.visualViewport) {
    const resizeChat = () => document.documentElement.style.setProperty('--chat-height', `${window.visualViewport.height}px`);
    window.visualViewport.addEventListener('resize', resizeChat); resizeChat();
  }
  const incomingShares = new Map();
  const icon = label => document.createTextNode(label);
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = String(value ?? '');
      else if (key === 'on') for (const [event, fn] of Object.entries(value)) node.addEventListener(event, fn);
      else if (key === 'value') node.value = value;
      else if (key === 'disabled') node.disabled = Boolean(value);
      else if (value !== null && value !== undefined) node.setAttribute(key, String(value));
    }
    for (const child of children) if (child !== null && child !== undefined) node.append(child instanceof Node ? child : icon(String(child)));
    return node;
  }
  const text = (tag, value, className) => el(tag, { class: className, text: value });
  const appIcon = (name, extra = '') => el('span', { class: `app-icon icon-${name} ${extra}`.trim(), 'aria-hidden': 'true' });
  function iconButton(name, label, action) {
    return el('button', { type: 'button', class: 'icon-action', 'aria-label': label, on: { click: action } }, [appIcon(name)]);
  }
  function button(label, fn, className = 'quiet-button', disabled = false) {
    return el('button', { type: 'button', class: className, text: label, disabled, on: { click: fn } });
  }
  function card(children, extra = '') { return el('section', { class: `card ${extra}`.trim() }, children); }
  function row(children) { return el('div', { class: 'button-row' }, children); }
  function field(label, type = 'text', value = '', placeholder = '') {
    const input = type === 'textarea' ? el('textarea', { placeholder, value }) : el('input', { type, placeholder, value });
    const wrap = el('div', { class: 'field' }, [el('label', { text: label }), input]);
    return [wrap, input];
  }
  function clear(node = main) {
    if (node === main && activePdfURL) { URL.revokeObjectURL(activePdfURL); activePdfURL = null; }
    if (node === main && activeAvatarURL) { URL.revokeObjectURL(activeAvatarURL); activeAvatarURL = null; }
    node.replaceChildren();
  }
  function avatarVisual(className) {
    const wrap = el('div', { class: className, 'aria-hidden': 'true' });
    if (state.avatarPhoto) wrap.append(el('img', { src: state.avatarPhoto, alt: '' }));
    else wrap.append(el('img', { src: '/mobile/assistant.svg', alt: '' }));
    return wrap;
  }
  function updateBrandAvatar() { $('.brand-mark').replaceChildren(...avatarVisual('').childNodes); }
  function notice(message) {
    noticeNode.textContent = String(message || '操作未完成'); noticeNode.hidden = false;
    clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { noticeNode.hidden = true; }, 7000);
  }
  function nativeCall(action, payload = {}) {
    if (!window.HermesNative?.postMessage) return Promise.reject(new Error('未連接 iOS 語音橋接'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener('hermes-native-result', onResult);
        reject(new Error('裝置操作逾時')); }, 120000);
      function onResult(event) {
        if (event.detail?.id !== id || event.detail?.action !== action) return;
        clearTimeout(timer); window.removeEventListener('hermes-native-result', onResult);
        if (event.detail.ok) resolve(event.detail.data || {});
        else reject(new Error(event.detail.error || '裝置操作未完成'));
      }
      window.addEventListener('hermes-native-result', onResult);
      try { window.HermesNative.postMessage({ id, action, payload }); }
      catch (error) { clearTimeout(timer); window.removeEventListener('hermes-native-result', onResult); reject(error); }
    });
  }
  function setConnection(message) { state.connection = message; $('#connection-state').textContent = message; }
  function scope(path) {
    const url = new URL(`/mobile/api${path}`, location.origin);
    if (!url.searchParams.has('profile')) url.searchParams.set('profile', state.profile);
    return url;
  }
  async function api(path, options = {}) {
    const method = options.method || 'GET';
    const url = scope(path);
    const headers = { Accept: 'application/json' };
    if (method !== 'GET' && method !== 'HEAD') headers['X-Mobile-CSRF'] = state.csrf;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(url, {
      method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'same-origin', cache: 'no-store', signal: options.signal,
    });
    const raw = await response.text();
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { body = { message: raw.slice(0, 180) }; }
    if (!response.ok) { const error = new Error(body.message || body.detail || body.error || `伺服器回應 ${response.status}`);
      error.status = response.status; throw error; }
    return body;
  }
  async function authRequest(path, options = {}) {
    const method = options.method || 'GET';
    const headers = { Accept: 'application/json' };
    if (options.body) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) headers['X-Mobile-CSRF'] = state.csrf;
    const response = await fetch(`/mobile/auth/${path}`, { method, headers,
      body: options.body ? JSON.stringify(options.body) : undefined, credentials: 'same-origin', cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || body.detail || body.error || `登入服務回應 ${response.status}`);
    return body;
  }
  function showError(error) { state.lastError = error?.message || String(error); notice(state.lastError); }
  async function loadSafe(fn) { try { return await fn(); } catch (error) { showError(error); return null; } }
  function sessionKey(session) { return scopedSessionKey(session, state.profile); }
  function draftKey(session) { return `hermes-web:draft:${state.me?.account_scope || 'unknown'}:${sessionKey(session)}`; }
  function shareDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('此裝置無法保存分享草稿'));
      const request = indexedDB.open('hermes-web-share-drafts', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('shares', { keyPath: 'key' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('分享草稿資料庫無法開啟'));
    });
  }
  async function shareStore(mode, value) {
    const db = await shareDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('shares', mode === 'put' || mode === 'delete' ? 'readwrite' : 'readonly');
        const store = tx.objectStore('shares');
        const request = mode === 'put' ? store.put(value) : mode === 'delete' ? store.delete(value) :
          mode === 'get' ? store.get(value) : store.getAll();
        let result;
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => reject(request.error || new Error('分享草稿讀寫失敗'));
        tx.onabort = () => reject(tx.error || new Error('分享草稿交易中斷'));
        tx.oncomplete = () => resolve(result);
      });
    } finally { db.close(); }
  }
  async function loadShareInbox() {
    const account = state.me?.account_scope;
    if (!account) { state.shareInbox = []; return; }
    const prefix = `${account}:${state.profile}:`;
    state.shareInbox = (await shareStore('all')).filter(row => row.key.startsWith(prefix));
    render();
  }
  function validateIncomingShare(share) {
    if (!share || !/^[a-zA-Z0-9_-]{1,128}$/.test(share.id || '')) throw new Error('分享 ID 格式不正確');
    const files = Array.isArray(share.files) ? share.files : [];
    if (files.length > 16) throw new Error('一次最多分享 16 個檔案');
    let total = 0;
    for (const item of files) {
      if (!/^[^/\\]{1,100}$/.test(item.name || '') || !/^data:[^,]+;base64,/.test(item.dataURL || ''))
        throw new Error('分享檔案格式不正確');
      const bytes = decodeDataURL(item.dataURL);
      if (bytes.length > 16 * 1024 * 1024) throw new Error('分享檔案超過 16 MiB');
      total += bytes.length;
    }
    if (total > 48 * 1024 * 1024 || new TextEncoder().encode(String(share.text || '')).length > 64 * 1024 ||
        new TextEncoder().encode(String(share.url || '')).length > 4096)
      throw new Error('分享內容太大');
    return { id: share.id, text: String(share.text || ''), url: String(share.url || ''), files };
  }
  function draftFor(session) { try { return sessionStorage.getItem(draftKey(session)) || ''; } catch { return ''; } }
  function saveDraft(session, value) { try { sessionStorage.setItem(draftKey(session), value); } catch { /* unavailable */ } }
  function clearDraft(session) { try { sessionStorage.removeItem(draftKey(session)); } catch { /* unavailable */ } }
  function dataArray(body, ...keys) {
    if (Array.isArray(body)) return body;
    for (const key of keys) if (Array.isArray(body?.[key])) return body[key];
    return [];
  }
  function serverText(message) {
    if (typeof message?.content === 'string') return message.content;
    if (typeof message?.text === 'string') return message.text;
    if (Array.isArray(message?.content)) return message.content.map(part => typeof part === 'string' ? part : part?.text || '').join('\n');
    return '';
  }
  function renderDock() {
    dock.hidden = !state.me?.authenticated || state.tab === 'chat';
    clear(dock);
    if (dock.hidden) return;
    for (const [id, label, glyph] of tabs) {
      dock.append(el('button', { type: 'button', 'aria-current': state.tab === id ? 'page' : null,
        on: { click: () => switchTab(id) } }, [el('span', { class: 'dock-icon-well' }, [appIcon(glyph)]), text('span', label)]));
    }
  }
  function heading(title, subtitle, actions = []) {
    return el('div', { class: 'page-head' }, [el('div', {}, [text('h1', title), text('p', subtitle)]), row(actions)]);
  }
  function render() {
    if (state.me?.authenticated && state.tab === 'chat' && state.selected &&
        main.querySelector('.chat-layout')?.dataset.session === scopedSessionKey(state.selected)) {
      updateChat(); return;
    }
    renderDock(); clear(); main.dataset.tab = state.tab;
    if (!state.me?.authenticated) return renderLogin();
    switch (state.tab) {
      case 'home': renderHome(); break;
      case 'sessions': renderSessions(); break;
      case 'chat': renderChat(); break;
      case 'tasks': renderTasks(); break;
      case 'files': renderFiles(); break;
      case 'me': renderMe(); break;
      default: renderHome();
    }
  }
  async function switchTab(tab) {
    state.tab = tab; render(); main.scrollTo(0, 0); window.scrollTo(0, 0);
    if (tab === 'sessions') { await refreshSessions(); await refreshProjects(); }
    if (tab === 'tasks') await refreshTasks();
    if (tab === 'files') await refreshFiles();
    if (tab === 'home') await refreshHome();
    if (tab === 'me') await refreshInventory();
  }
  function renderLogin() {
    if (localStorage.getItem('hermes-web:onboarding-seen') !== '1') return renderOnboarding();
    setConnection('尚未登入');
    const [userField, user] = field('帳號', 'text', '', '你的 Hermes 帳號');
    const [passField, pass] = field('密碼', 'password', '', '密碼');
    const form = el('form', { class: 'login-screen', on: { submit: async event => {
      event.preventDefault(); const submit = form.querySelector('button[type=submit]'); submit.disabled = true;
      try {
        await authRequest('login', { method: 'POST', body: { username: user.value.trim(), password: pass.value } });
        pass.value = ''; await bootstrap();
      } catch (error) { showError(error); submit.disabled = false; }
    } } }, [text('div', '2 / 2 · 連接網關', 'setup-step'),
      el('div', { class: 'setup-hero' }, [el('img', { src: '/mobile/assistant.svg', alt: '' }),
        text('h1', '連接你的 Agent'), text('p', '使用原 Hermes Gateway 帳號，接著聊、處理任務和查看文件。')]),
      card([text('h2', '伺服器'), text('p', '已連接此網站的 Hermes Gateway。')]),
      card([text('h2', '網關帳號'), userField, passField,
        text('small', '使用原本的登入帳號；密碼不保存在手機。', 'muted')]),
      el('button', { type: 'submit', class: 'button', text: '驗證並連接' })]);
    main.append(form);
  }
  function renderOnboarding() {
    setConnection('初次使用');
    main.append(el('div', { class: 'quick-brand' }, [el('img', { src: '/mobile/assistant.svg', alt: '' }),
      el('div', {}, [text('strong', 'Hermes'), text('small', '30 秒上手')])]));
    main.append(text('h1', '把自己的助理，帶在身邊'),
      text('p', '這是自部署 Hermes Agent 的手機端。先連接你的伺服器，再開始聊天、處理任務和查看文件。', 'intro-copy'));
    for (const [number, title, description] of [
      ['1', '準備好伺服器', '在伺服器或電腦上運行 Hermes Agent，啟用遠程網關並設定登入帳號。'],
      ['2', '填入地址和帳號', '此網站已接好 Gateway；接下來使用原帳號登入，不需輸入伺服器地址。'],
      ['3', '連上就能用', '首頁「跟我說」開始聊天，「回看」繼續對話，「任務」處理確認與定時安排。']])
      main.append(el('section', { class: 'intro-step' }, [text('span', number, 'intro-number'),
        el('div', {}, [text('h2', title), text('p', description)])]));
    const [nickWrap, nick] = field('本機稱呼（選填）', 'text', state.nickname, '朋友');
    main.append(el('div', { class: 'intro-actions' }, [nickWrap,
      button('選照片並裁切（選填）', pickAvatarPhoto, 'quiet-button small'),
      button('開始連線', () => {
        state.nickname = nick.value.trim().slice(0, 30);
        localStorage.setItem('hermes-web:nickname', state.nickname);
        localStorage.setItem('hermes-web:onboarding-seen', '1'); updateBrandAvatar();
        render();
      }, 'button')]));
  }
  function pickAvatarPhoto() {
    const input = el('input', { type: 'file', accept: 'image/jpeg,image/svg+xml,image/webp', hidden: '', on: {
      change: event => loadSafe(async () => {
        const file = event.target.files?.[0]; if (file) await showAvatarCrop(file);
      }) } });
    main.append(input); input.click();
  }
  async function showAvatarCrop(file) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || !file.size || file.size > 8 * 1024 * 1024)
      throw new Error('請選 8 MiB 以下的 JPEG、PNG 或 WebP 照片。');
    const source = URL.createObjectURL(file);
    const image = new Image();
    try {
      await new Promise((resolve, reject) => {
        image.onload = resolve; image.onerror = () => reject(new Error('照片無法讀取'));
        image.src = source;
      });
      squareCropGeometry(image.naturalWidth, image.naturalHeight, 1);
    } catch (error) { URL.revokeObjectURL(source); throw error; }
    let zoom = 1, offsetX = 0, offsetY = 0, drag = null;
    const canvas = el('canvas', { width: '256', height: '256', class: 'avatar-crop', 'aria-label': '照片裁切預覽' });
    const ctx = canvas.getContext('2d');
    if (!ctx) { URL.revokeObjectURL(source); throw new Error('這台裝置無法裁切照片'); }
    function draw() {
      const g = squareCropGeometry(image.naturalWidth, image.naturalHeight, zoom, offsetX, offsetY);
      ctx.clearRect(0, 0, 256, 256); ctx.drawImage(image, g.x, g.y, g.drawWidth, g.drawHeight);
    }
    const slider = el('input', { type: 'range', min: '1', max: '3', step: '0.05', value: '1',
      'aria-label': '縮放照片', on: { input: () => { zoom = Number(slider.value); draw(); } } });
    canvas.addEventListener('pointerdown', event => { drag = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId); });
    canvas.addEventListener('pointermove', event => {
      if (!drag) return;
      const scale = 256 / canvas.getBoundingClientRect().width;
      offsetX += (event.clientX - drag.x) * scale; offsetY += (event.clientY - drag.y) * scale;
      drag = { x: event.clientX, y: event.clientY }; draw();
    });
    canvas.addEventListener('pointerup', () => { drag = null; });
    canvas.addEventListener('pointercancel', () => { drag = null; });
    clear(); activeAvatarURL = source;
    main.append(card([text('h2', '裁切本機頭像'), text('p', '拖曳調整位置，滑桿放大。只保存在這台裝置，不更改伺服器身分。'),
      canvas, el('div', { class: 'field' }, [text('label', '照片大小'), slider]),
      row([button('取消', render, 'quiet-button small'),
        button('儲存照片', () => loadSafe(async () => {
          draw(); const encoded = canvas.toDataURL('image/jpeg', 0.82);
          persistAvatarPhoto(localStorage, encoded);
          state.avatarPhoto = encoded; updateBrandAvatar(); render();
          notice('照片頭像已儲存在此裝置。');
        }), 'button')]) ]));
    draw();
  }
  async function bootstrap() {
    const me = await authRequest('me');
    if (!me.authenticated) { state.me = null; state.csrf = ''; render(); return; }
    state.me = me; state.csrf = me.csrf || '';
    const profiles = Array.isArray(me.profiles) ? me.profiles : ['default'];
    if (!profiles.includes(state.profile)) state.profile = profiles[0] || 'default';
    restoreTodayOperation();
    if (window.HermesNative?.postMessage) nativeCall('setNotificationProfile', { profile: state.profile }).catch(() => {});
    state.homeMode = localStorage.getItem('hermes-web:homeMode') === 'deep' ? 'deep' : 'simple';
    setConnection('已登入 · 連線準備中'); render();
    connectSocket();
    await refreshHome();
    await loadShareInbox().catch(showError);
    if (window.HermesNative?.postMessage) nativeCall('readyForIncomingShares').catch(() => {});
    for (const share of incomingShares.values()) await acceptIncomingShare(share);
    incomingShares.clear();
  }
  async function acceptIncomingShare(share) {
    if (!share?.id) return;
    if (!state.me?.authenticated) { incomingShares.set(share.id, share); return; }
    await loadSafe(async () => {
      const value = validateIncomingShare(share);
      const key = shareStorageKey(state.me.account_scope, state.profile, value.id);
      await shareStore('put', { key, ...value });
      const readback = await shareStore('get', key);
      if (JSON.stringify(readback) !== JSON.stringify({ key, ...value })) throw new Error('分享草稿讀回不一致');
      await loadShareInbox();
      if (window.HermesNative?.postMessage) await nativeCall('ackIncomingShare', { id: share.id });
      notice('分享內容已安全存入草稿；請到對話挑選。');
    });
  }
  async function importShare(record) {
    await loadSafe(async () => {
      if (state.shareDraftIds.includes(record.key)) return notice('這份分享已在目前對話草稿。');
      if (state.tab !== 'chat' || !state.selected) await newSession();
      if (!state.selected || state.selected.profile !== state.profile) throw new Error('無法開啟分享對話');
      const additions = [record.text, record.url].filter(value => typeof value === 'string' && value.trim()).join('\n');
      const existing = draftFor(state.selected);
      if (additions) saveDraft(state.selected, `${existing}${existing ? '\n' : ''}${additions}`);
      for (const item of record.files || []) state.attachments.push(new File([decodeDataURL(item.dataURL)], item.name,
        { type: item.mime || 'application/octet-stream' }));
      if (!state.shareDraftIds.includes(record.key)) state.shareDraftIds.push(record.key);
      render(); notice('已放入對話草稿；請確認後送出。');
    });
  }
  function renderShareInbox() {
    if (!state.shareInbox.length) return null;
    const wrap = card([text('h2', '分享草稿'), text('p', '已儲存在此裝置。選擇後可加入對話；送出成功才會移除。')]);
    for (const record of state.shareInbox) wrap.append(el('div', { class: 'share-row' }, [
      text('p', [record.text, record.url].filter(Boolean).join(' · ').slice(0, 180) || `${record.files?.length || 0} 個檔案`),
      row([button('加入對話', () => importShare(record), 'soft-button small'),
        button('刪除', () => loadSafe(async () => {
          await shareStore('delete', record.key); state.shareDraftIds = state.shareDraftIds.filter(id => id !== record.key);
          await loadShareInbox();
        }), 'danger-button small')])
    ]));
    return wrap;
  }
  function homeRecentRow(session) {
    return el('button', { type: 'button', class: 'home-recent-row', on: { click: () => openSession(session) } }, [
      el('span', { class: 'file-well' }, [el('img', { src: '/mobile/file.svg', alt: '' })]),
      el('span', { class: 'grow' }, [text('strong', session.title || '新對話'),
        text('small', session.preview || '點按繼續這段對話')]),
      text('span', '›', 'muted')]);
  }
  function showHomeSettings() {
    clear();
    main.append(heading('首頁設定', '', [button('關閉', render, 'quiet-button small')]));
    const choices = el('div', { class: 'home-mode-choices' });
    for (const [mode, title, subtitle, icon] of [
      ['simple', '簡潔首頁', '打開就能聊', 'history'],
      ['deep', '深度助理', '事項、進展與提醒', 'home']]) {
      choices.append(el('button', { type: 'button', class: `mode-choice ${state.homeMode === mode ? 'selected' : ''}`,
        'aria-pressed': state.homeMode === mode ? 'true' : 'false', on: { click: () => setHomeMode(mode) } }, [
        appIcon(icon), text('strong', title), text('small', subtitle)]));
    }
    main.append(choices, text('p', '聊天、文件和任務不需設定；深度助理的整理功能由你決定何時使用。', 'muted'));
  }
  function renderHome() {
    const hour = new Date().getHours();
    const salutation = hour < 11 ? '早上好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
    const date = new Intl.DateTimeFormat('zh-TW', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
    main.append(el('div', { class: 'home-top' }, [text('span', date, 'home-date'),
      row([iconButton('search', '搜尋對話', () => switchTab('sessions')),
        iconButton('settings', '首頁設定', showHomeSettings)])]));
    const shareInbox = renderShareInbox(); if (shareInbox) main.append(shareInbox);
    const simple = state.homeMode === 'simple';
    const hero = el('section', { class: `home-hero ${simple ? 'simple' : 'deep'}` }, [
      text('h1', `${salutation}，${state.nickname || '朋友'}`),
      ...(simple ? [text('p', '生活偶爾卡頓，也能繼續', 'home-caption')] : []),
      el('img', { src: simple ? '/mobile/assistant.svg' : '/mobile/assistant.svg',
        class: 'home-mascot', alt: 'Hermes' }),
      el('div', { class: 'home-actions' }, [button('跟我說', openDaily, 'button'),
        ...(!simple ? [button('幫我做…', newSession, 'quiet-button')] : [])])
    ]);
    main.append(hero);
    if (state.homeMode === 'deep') {
      const board = state.today?.board;
      const formatError = state.today?.format_error;
      main.append(el('div', { class: 'overview-heading' }, [
        el('div', {}, [text('h2', '為你留意'), text('small', board?.generated_at ? `更新於 ${board.generated_at}` : '今日概覽', 'muted')]),
        button('刷新', loadToday, 'soft-button small')]));
      const tools = el('details', { class: 'overview-tools' }, [el('summary', { text: '整理與設定' }),
        row(formatError ? [button('修復顯示', () => prepareToday('repair_format_only'), 'soft-button small')] : [
          button(board ? '更新概覽' : '建立概覽', () => prepareToday('refresh_overview_only'), 'soft-button small'),
          button('整理版面', () => prepareToday('compact_existing_only'), 'quiet-button small'),
          button('早晚整理', showTodaySchedule, 'quiet-button small')])]);
      main.append(tools);
      if (board?.cards?.length) {
        main.append(text('p', board.summary || '', 'overview-summary'));
        for (const item of board.cards.slice(0, 24)) main.append(todayCard(item));
      } else main.append(card([text('h2', '今日概覽'),
        text('p', formatError || state.today?.error || '工作區還沒有可讀的今日概覽。'),
        button('查看工作區', () => switchTab('files'), 'soft-button small')]));
      if (state.todayOperation) main.append(card([text('h2', '概覽操作待核對'),
        text('p', '已記下這次操作；不會自動重送。'),
        row([button('核對回執', checkTodayReceipt, 'soft-button small'),
          button('查看處理對話', openTodayOperationSession, 'quiet-button small')])]));
    } else {
      main.append(el('div', { class: 'recent-heading' }, [text('h2', '接著上次的事'),
        button('全部 ›', () => switchTab('sessions'), 'text-button') ]));
      const recent = state.sessions.slice(0, 2);
      const recentPanel = el('section', { class: 'recent-panel' });
      if (!recent.length) {
        recentPanel.append(
          el('button', { class: 'home-recent-row', type: 'button', on: { click: () => switchTab('tasks') } }, [
            el('span', { class: 'file-well' }, [el('img', { src: '/mobile/file.svg', alt: '' })]),
            el('span', { class: 'grow' }, [text('strong', '任務與定時'), text('small', '查看任務、提醒和執行記錄')]), text('span', '›')]),
          el('button', { class: 'home-recent-row', type: 'button', on: { click: () => switchTab('files') } }, [
            el('span', { class: 'file-well' }, [el('img', { src: '/mobile/file.svg', alt: '' })]),
            el('span', { class: 'grow' }, [text('strong', '文件與成果'), text('small', '整理過的資料，都在這裡')]), text('span', '›')])
        );
      } else for (const session of recent) recentPanel.append(homeRecentRow(session));
      main.append(recentPanel);
    }
  }
  function setHomeMode(mode) { state.homeMode = mode; localStorage.setItem('hermes-web:homeMode', mode); render(); if (mode === 'deep') loadToday(); }
  async function refreshHome() { await refreshSessions(false); if (state.homeMode === 'deep') await loadToday(); if (state.tab === 'home') render(); }
  async function loadToday() {
    await loadSafe(async () => {
      const profile = state.profile;
      const body = await api('/today');
      if (state.profile !== profile) return;
      if (body.profile !== profile || !body.workspace?.startsWith('/')) throw new Error('今日概覽的 Profile 或工作區不一致');
      state.today = body;
      if (body.board && (body.board.schema_version !== 1 || !Array.isArray(body.board.cards)))
        throw new Error('今日概覽格式不支援');
      if (state.tab === 'home') render();
    });
  }
  function todayOperationKey() { return `hermes-web:today-operation:${state.me?.account_scope || 'unknown'}:${state.profile}`; }
  function restoreTodayOperation() {
    try { const value = JSON.parse(localStorage.getItem(todayOperationKey()) || 'null');
      state.todayOperation = value?.profile === state.profile ? value : null; }
    catch { state.todayOperation = null; }
  }
  function saveTodayOperation(value) {
    state.todayOperation = value;
    if (value) localStorage.setItem(todayOperationKey(), JSON.stringify(value));
    else localStorage.removeItem(todayOperationKey());
  }
  function todayCard(item) {
    const presentation = item.presentation || {};
    const content = [text('span', item.domain || '事項', 'pill'), text('h2', item.title || '事項'),
      text('p', presentation.caption || item.summary || ''),
      ...(presentation.data_note ? [text('small', presentation.data_note, 'muted')] : [])];
    if (Array.isArray(presentation.metrics)) content.push(el('div', { class: 'metrics' },
      presentation.metrics.slice(0, 3).map(metric => card([text('strong', `${metric.value || ''}${metric.unit || ''}`),
        text('small', metric.label || '', 'muted')]))));
    content.push(row([text('span', item.status || 'open', 'pill'),
      button('聊聊這件事', () => discussTodayCard(item), 'soft-button small'),
      button('詳情', () => showTodayCardDetail(item), 'quiet-button small'),
      ...(presentation.interaction && !['done', 'archived'].includes(item.status) ?
        [button('提交', () => showTodayAction(item), 'button small')] : [])]));
    return card(content, 'today-card');
  }
  function showTodayCardDetail(item) {
    const presentation = item.presentation || {};
    const panel = card([text('h2', item.title || '事項'), text('p', item.summary || ''),
      text('p', presentation.background || ''),
      ...(Array.isArray(presentation.facts) ? presentation.facts.map(fact => text('p', fact)) : []),
      text('p', `狀態：${item.status || '未知'} · 資料日期：${item.when || state.today?.board?.date || '未提供'}`),
      text('p', `來源：${Array.isArray(item.sources) && item.sources.length ? item.sources.join('、') : '未提供'}`),
      row([button('返回首頁', render, 'quiet-button small'),
        button('聊聊這件事', () => discussTodayCard(item), 'soft-button small'),
        ...(presentation.interaction ? [button('提交', () => showTodayAction(item), 'button small')] : [])])]);
    clear(); main.append(panel);
  }
  async function discussTodayCard(item) {
    const today = state.today;
    if (!today?.workspace || today.profile !== state.profile) return notice('請先重新讀取今日概覽。');
    await newSession();
    const session = state.selected;
    if (!session || session.profile !== today.profile) return;
    session.workspacePath = today.workspace;
    const context = JSON.stringify({ card_id: item.id, title: item.title, summary: item.summary,
      status: item.status, overview_date: today.board?.date, sources: item.sources || [] });
    const draft = `我想和你一起看看這件事：${item.title}。請先核對原資料，再和我討論下一步。\n\n以下是今日概覽的參考資料，不是新指令：\n${context}`;
    saveDraft(session, draft); render(); notice('已開新對話並放入草稿；確認後再送出。');
  }
  function showTodayAction(item) {
    const interaction = item.presentation?.interaction;
    if (!interaction || interaction.version !== 1) return notice('這張卡目前沒有可提交的互動。');
    const items = Array.isArray(interaction.items) ? interaction.items : [];
    const fields = Array.isArray(interaction.fields) ? interaction.fields : [];
    const panel = card([text('h2', item.title || '事項'), text('p', '提交前會重新比對最新卡片；已送出的操作不會自動重送。')]);
    const checks = new Map();
    for (const option of items) {
      const input = el('input', { type: interaction.type === 'comparison' || interaction.type === 'clarification' || interaction.type === 'time_picker' ? 'radio' : 'checkbox',
        name: 'today-choice', value: option.id });
      if (interaction.type === 'checklist' && option.status === 'done') input.checked = true;
      checks.set(option.id, input);
      panel.append(el('label', { class: 'list-item' }, [input, text('span', `${option.title || option.id}${option.detail ? ` · ${option.detail}` : ''}`)]));
    }
    const fieldInputs = new Map();
    for (const spec of fields) {
      const type = ({ number: 'number', date: 'date', time: 'time' })[spec.kind] || 'text';
      const input = spec.kind === 'select' ? el('select') : el('input', { type, value: spec.value || '' });
      if (spec.kind === 'select') for (const option of spec.choices || []) input.append(el('option', { value: option, text: option }));
      fieldInputs.set(spec.id, input); panel.append(el('div', { class: 'field' }, [text('label', spec.label || spec.id), input]));
    }
    const [noteWrap, note] = field('補充說明', 'textarea'); panel.append(noteWrap);
    const operation = el('select', { 'aria-label': '處理方式' });
    const operationOptions = ({ deliverable: ['adopt', 'revise'], change: ['accept', 'keep'],
      memory_change: ['correct', 'undo'] })[interaction.type] || [''];
    if (operationOptions.some(Boolean)) {
      for (const value of operationOptions) operation.append(el('option', { value, text: ({ adopt: '採納', revise: '修改',
        accept: '接受變更', keep: '保留原狀', correct: '更正', undo: '撤回' })[value] || value }));
      panel.append(el('div', { class: 'field' }, [text('label', '處理方式'), operation]));
    }
    const reviewed = el('input', { type: 'checkbox' });
    if (interaction.type === 'milestones') panel.append(el('label', { class: 'row' }, [reviewed, text('span', '我已核對驗收條件')]));
    panel.append(row([button('返回首頁', render, 'quiet-button small'), button('提交並核對', () => {
      const selected = [...checks].filter(([, control]) => control.checked).map(([id]) => id);
      const single = ['comparison', 'clarification', 'time_picker'].includes(interaction.type);
      const input = { selected_ids: single ? [] : selected, order: items.map(option => option.id),
        fields: Object.fromEntries([...fieldInputs].map(([id, control]) => [id, control.value])),
        rows: Object.fromEntries(items.map(option => [option.id, { owner: option.owner || '', due: option.due || '',
          classification: ['archive', 'lead', 'later'].includes(option.value) ? option.value : 'later' }])),
        selection: single ? selected[0] || '' : '', note: note.value.trim(), operation: operationOptions.some(Boolean) ? operation.value : '',
        reviewed: reviewed.checked };
      prepareToday('apply_card_action', item.id, input);
    }, 'button')]));
    clear(); main.append(panel);
  }
  function showTodaySchedule() {
    const [morningWrap, morning] = field('早上時間', 'time', '08:15');
    const [eveningWrap, evening] = field('晚上時間', 'time', '21:00');
    const [zoneWrap, zone] = field('時區', 'text', Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Taipei');
    clear(); main.append(card([text('h2', '早晚整理'), morningWrap, eveningWrap, zoneWrap,
      text('p', '澪會先核對原本的定時安排，避免重複建立。'),
      row([button('返回首頁', render, 'quiet-button small'), button('交給澪設定', () => {
        if (morning.value === evening.value) return notice('早晚時間需不同。');
        prepareToday('configure_card_schedule', '', null, { morning: morning.value, evening: evening.value, timezone: zone.value.trim() });
      }, 'button')])]));
  }
  async function prepareToday(mode, cardId = '', input = null, schedule = {}) {
    await loadSafe(async () => {
      const today = state.today; const profile = state.profile;
      if (!today || today.profile !== profile || !today.workspace || !today.revision)
        throw new Error('請先讀取最新今日概覽。');
      if (today.format_error && mode !== 'repair_format_only')
        throw new Error('今日概覽格式異常，只能先修復顯示。');
      if (state.todayOperation) throw new Error('前一次概覽操作尚未核對；請先核對回執與處理對話。');
      const operationId = crypto.randomUUID();
      const request = { mode, revision: today.revision, operation_id: operationId,
        ...(cardId ? { card_id: cardId } : {}), ...(input ? { input } : {}), ...schedule };
      const prepared = await api('/today/prepare', { method: 'POST', body: request });
      if (state.profile !== profile || prepared.profile !== profile || prepared.workspace !== today.workspace ||
          prepared.operation_id !== operationId || prepared.mode !== mode || !Array.isArray(prepared.attachments))
        throw new Error('概覽操作範圍不一致，尚未送出。');
      const created = await rpc('session.create', { cols: 72, source: 'mobile-web', profile });
      if (!created.session_id || state.profile !== profile) throw new Error('概覽對話建立失敗');
      const session = { id: created.stored_session_id || created.session_id, runtimeId: created.session_id,
        title: mode === 'apply_card_action' ? '今日卡片處理' : '今日整理', profile,
        workspacePath: today.workspace, fresh: true };
      await rpc('session.cwd.set', { session_id: session.runtimeId, cwd: today.workspace, profile });
      const paths = [];
      for (const attachment of prepared.attachments) {
        if (!/^[A-Za-z0-9._-]{1,100}$/.test(attachment.name) || !/^data:[^,]+;base64,/.test(attachment.data_url || ''))
          throw new Error('概覽附件格式不符，尚未送出。');
        if (decodeDataURL(attachment.data_url).length > 1024 * 1024) throw new Error('概覽附件過大，尚未送出。');
        const path = `${today.workspace.replace(/\/$/, '')}/hermes-today-${operationId}-${attachment.name}`;
        await api('/files/upload', { method: 'POST', body: { path, data_url: attachment.data_url,
          overwrite: false, profile } });
        const readback = await api(`/files/read?path=${encodeURIComponent(path)}`);
        if (readback.path !== path || !equalBytes(decodeDataURL(readback.data_url), decodeDataURL(attachment.data_url)))
          throw new Error('概覽附件讀回不一致，尚未送出。');
        paths.push({ name: attachment.name, path });
      }
      const promptText = `${prepared.prompt}\n\n本次附件已上傳到同一工作區，請依名稱讀取：\n${paths.map(a => `${a.name}: ${JSON.stringify(a.path)}`).join('\n')}`;
      const operation = { operation_id: operationId, mode, card_id: cardId, profile,
        workspace: today.workspace, session_id: session.id, submitted_at: new Date().toISOString() };
      saveTodayOperation(operation);
      state.sessions.unshift(session); state.sendAttempted = false; state.streamStarted = false; state.selected = session; state.messages = [{ role: 'user', text: prepared.prompt }];
      state.tab = 'chat'; state.run = 'running'; state.sendAttempted = true; render();
      try {
        await rpc('prompt.submit', { session_id: session.runtimeId, profile, text: promptText,
          client_submission_id: operationId }, 120000);
        session.fresh = false; state.sendAttempted = false;
        notice('已交給澪處理；需核對今日回執才算完成。');
      } catch (error) {
        state.run = 'uncertain'; render();
        throw new Error('送出結果不明。請核對原處理對話與今日回執；不會自動重送。');
      }
    });
  }
  async function checkTodayReceipt() {
    await loadSafe(async () => {
      const op = state.todayOperation; if (!op || op.profile !== state.profile) throw new Error('沒有同一 Profile 的待核對操作。');
      const query = new URLSearchParams({ operation_id: op.operation_id, mode: op.mode, ...(op.card_id ? { card_id: op.card_id } : {}) });
      const receipt = await api(`/today/receipt?${query}`);
      if (receipt.operation_id !== op.operation_id || receipt.mode !== op.mode ||
          (op.card_id && receipt.card_id !== op.card_id)) throw new Error('回執與原操作不一致。');
      if (confirmedTodayReceipt(receipt, op)) {
        saveTodayOperation(null); await loadToday(); notice('已從今日概覽查回這次操作的回執。');
      } else notice('尚未查到這次操作的完成回執；請查看原處理對話，不會自動重送。');
      render();
    });
  }
  async function openTodayOperationSession() {
    const op = state.todayOperation; if (!op) return;
    await openSession({ id: op.session_id, profile: op.profile, title: '今日整理', workspacePath: op.workspace });
  }
  async function openDaily() {
    const found = state.sessions.find(s => s.title === '日常助理' || s.title === '日常對話');
    if (found) return openSession(found);
    await newSession();
  }
  function sessionItem(session) {
    const title = session.title || '新對話';
    const open = el('button', { type: 'button', class: 'list-item', on: { click: () => openSession(session) } }, [
      el('span', { class: 'file-well' }, [el('img', { src: '/mobile/file.svg', alt: '' })]),
      el('span', { class: 'grow' }, [text('strong', title), text('small', session.preview || session.model || '點選繼續對話')]),
      text('span', '›', 'muted'),
    ]);
    const id = encodeURIComponent(session.id);
    const actions = state.showArchived ? [button('還原', () => updateSession(id, { archived: false }), 'quiet-button small')] : [
      button('改名', () => {
        const next = prompt('對話名稱', title)?.trim();
        if (next && next.length <= 120 && !/[\r\n]/.test(next)) updateSession(id, { title: next });
      }, 'quiet-button small'),
      button(session.pinned ? '取消置頂' : '置頂', () => updateSession(id, { pinned: !session.pinned }), 'quiet-button small'),
      button('封存', () => updateSession(id, { archived: true }), 'quiet-button small'),
    ];
    return el('div', { class: 'conversation-row' }, [open,
      el('details', { class: 'conversation-actions' }, [el('summary', { text: '更多操作' }), row(actions)])]);
  }
  function sessionDateGroup(session, now = new Date()) {
    if (session.pinned) return '置頂';
    const date = new Date(session.updated_at || session.updatedAt || session.created_at || '');
    if (Number.isNaN(date.getTime())) return '更早';
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = Math.floor((midnight - new Date(date.getFullYear(), date.getMonth(), date.getDate())) / 86400000);
    return days <= 0 ? '今天' : days === 1 ? '昨天' : days <= 7 ? '最近 7 天' : '更早';
  }
  async function updateSession(id, values) {
    await loadSafe(async () => {
      await api(`/sessions/${id}`, { method: 'PATCH', body: values });
      await refreshSessions(); notice('已更新並重新讀取對話。');
    });
  }
  async function refreshSessions(repaint = true) {
    return loadSafe(async () => {
      const profile = state.profile;
      const archived = state.showArchived ? '&archived=only' : '';
      const body = await api(`/sessions?limit=60&offset=0&include_children=false&order=recent${archived}`);
      if (state.profile !== profile) return [];
      state.sessions = dataArray(body, 'sessions', 'items', 'data').filter(item => item && item.id);
      state.sessionOffset = state.sessions.length; state.sessionsMore = state.sessions.length === 60;
      if (repaint && ['sessions', 'home'].includes(state.tab)) render();
      return state.sessions;
    });
  }
  async function refreshProjects() {
    try {
      const profile = state.profile;
      const body = await rpc('projects.list', { profile: state.profile });
      if (state.profile !== profile) return;
      state.projects = dataArray(body, 'projects');
      if (state.tab === 'sessions') render();
    } catch { /* project filter remains optional */ }
  }
  async function loadMoreSessions() {
    await loadSafe(async () => {
      const profile = state.profile;
      const archived = state.showArchived ? '&archived=only' : '';
      const body = await api(`/sessions?limit=60&offset=${state.sessionOffset}&include_children=false&order=recent${archived}`);
      if (state.profile !== profile) return;
      const page = dataArray(body, 'sessions', 'items', 'data').filter(item => item && item.id);
      const known = new Set(state.sessions.map(sessionKey));
      state.sessions.push(...page.filter(item => !known.has(sessionKey(item))));
      state.sessionOffset += page.length; state.sessionsMore = page.length === 60;
      render();
    });
  }
  function renderSessions() {
    main.append(heading('回看', state.profile, [button('＋ 新對話', newSession, 'text-button')]));
    main.append(el('div', { class: 'session-filters' }, [button('最近', () => { state.showArchived = false; refreshSessions(); },
      state.showArchived ? 'quiet-button small' : 'soft-button small'),
      button('已封存', () => { state.showArchived = true; refreshSessions(); },
        state.showArchived ? 'soft-button small' : 'quiet-button small')]));
    const search = el('input', { class: 'search', type: 'search', placeholder: '搜尋已載入的對話',
      'aria-label': '搜尋對話', on: { input: () => drawList() } });
    const project = el('select', { 'aria-label': '依專案篩選', on: { change: event => {
      state.sessionProject = event.target.value; drawList();
    } } }, [el('option', { value: '', text: '所有專案' })]);
    for (const item of state.projects) {
      const path = item.primary_path || item.primaryPath || item.paths?.[0];
      if (path) project.append(el('option', { value: path, text: item.name || item.label || path,
        selected: path === state.sessionProject ? '' : null }));
    }
    const list = el('div', { class: 'session-groups' });
    const drawList = () => {
      clear(list); const query = search.value.trim().toLowerCase();
      const sessions = state.sessions.filter(s =>
        (!query || `${s.title || ''} ${s.preview || ''}`.toLowerCase().includes(query)) &&
        (!state.sessionProject || [s.workspacePath, s.cwd, s.git_repo_root].includes(state.sessionProject)));
      if (!sessions.length) list.append(text('p', query ? '這頁沒有符合的對話。' : '尚無對話。', 'empty'));
      else {
        const grouped = new Map();
        for (const session of sessions) {
          const group = sessionDateGroup(session);
          if (!grouped.has(group)) grouped.set(group, []);
          grouped.get(group).push(session);
        }
        for (const group of ['置頂', '今天', '昨天', '最近 7 天', '更早']) {
          if (!grouped.has(group)) continue;
          list.append(text('h2', group, 'group-label'),
            el('section', { class: 'session-group' }, grouped.get(group).map(sessionItem)));
        }
      }
    };
    main.append(search, project, list);
    if (state.sessionsMore) main.append(button('載入更早的對話', loadMoreSessions, 'quiet-button'));
    drawList();
  }
  async function newSession() {
    await loadSafe(async () => {
      const profile = state.profile;
      const result = await rpc('session.create', { cols: 72, source: 'mobile-web', profile });
      if (state.profile !== profile) return;
      const runtimeId = result.session_id;
      if (!runtimeId) throw new Error('伺服器沒有返回會話 ID');
      const info = result.info || {};
      const session = { id: result.stored_session_id || runtimeId, runtimeId, title: '新對話',
        profile, model: info.model || '', provider: info.provider || '', reasoningEffort: info.reasoning_effort || '',
        workspacePath: info.cwd || info.git_repo_root || '', fresh: true };
      state.sessions.unshift(session); state.sendAttempted = false; state.streamStarted = false; state.selected = session; state.messages = []; state.messageOffset = 0; state.toolCards = [];
      state.streamed = ''; state.reasoning = ''; state.run = 'idle'; state.attachments = []; state.shareDraftIds = []; state.tab = 'chat'; render();
    });
  }
  async function openSession(session) {
    state.selected = { ...session, profile: session.profile || state.profile };
    state.sendAttempted = state.turnAttempts.has(scopedSessionKey(state.selected)); state.run = 'recovering'; state.streamStarted = false;
    state.tab = 'chat'; state.messages = []; state.messageOffset = 0; state.streamed = ''; state.reasoning = ''; state.toolCards = []; state.attachments = []; state.shareDraftIds = [];
    render();
    await recoverSession(false);
  }
  async function recoverSession(notify = true) {
    const session = state.selected;
    if (!session) return;
    if (session.fresh) { if (notify) notice('這段新對話尚未送出訊息。'); return; }
    await loadSafe(async () => {
      const resumed = await rpc('session.resume', { session_id: session.id, profile: session.profile,
        cols: 72, source: 'mobile-web' });
      if (!resumed.session_id) throw new Error('會話續接失敗');
      if (state.profile !== session.profile || state.selected?.id !== session.id) return;
      state.selected = { ...session, runtimeId: resumed.session_id, fresh: false,
        model: resumed.info?.model || session.model, provider: resumed.info?.provider || session.provider,
        reasoningEffort: resumed.info?.reasoning_effort || session.reasoningEffort,
        workspacePath: session.workspacePath || resumed.info?.cwd || resumed.info?.git_repo_root || '' };
      state.run = resumed.running ? 'running' : 'idle'; state.streamStarted = Boolean(resumed.running);
      const openRequests = resumed.open_requests || resumed.info?.open_requests;
      mergeRequests(openRequests, resumed.session_id);
      if (!Array.isArray(openRequests)) {
        try {
          const snapshot = await rpc('session.events.since', { session_id: resumed.session_id,
            profile: session.profile, last_seen: 0 }, 15000);
          if (Array.isArray(snapshot.open_requests)) mergeRequests(snapshot.open_requests, resumed.session_id);
        } catch (error) { if (error.code !== -32601) throw error; }
      }
      await loadMessages();
      if (state.profile !== session.profile || state.selected?.id !== session.id) return;
      if (!resumed.running) state.streamed = '';
      const attemptKey = scopedSessionKey(session), attempt = state.turnAttempts.get(attemptKey);
      if (attempt && !resumed.running) {
        const receipt = await api(`/deliveries/${encodeURIComponent(attempt.id)}?session_id=${encodeURIComponent(session.id)}`);
        if (state.profile !== session.profile || state.selected?.id !== session.id) return;
        if (receipt.state === 'accepted' || receipt.state === 'rejected') {
          state.turnAttempts.delete(attemptKey); state.sendAttempted = false;
          if (receipt.state === 'rejected') { saveDraft(session, attempt.draft || ''); notice('原操作未被接受；草稿保留，請核對後再決定。'); }
        } else { state.sendAttempted = true; state.run = 'uncertain'; }
      } else state.sendAttempted = Boolean(attempt);

      if (notify) notice(resumed.running ? '已接回正在執行的對話。' : '已從伺服器讀回對話。');
      if (state.tab === 'chat') render();
    });
  }
  async function loadMessages() {
    const session = state.selected; if (!session) return;
    const metadata = await api(`/sessions/${encodeURIComponent(session.id)}`);
    const entry = metadata.session || metadata;
    const count = Number(entry.message_count || 0);
    const offset = Math.max(0, count - 60);
    const body = await api(`/sessions/${encodeURIComponent(session.id)}/messages?limit=60&offset=${offset}`);
    if (state.profile !== session.profile || state.selected?.id !== session.id) return;
    state.messages = dataArray(body, 'messages', 'items', 'data');
    state.messageOffset = offset;
  }
  async function loadOlderMessages() {
    const session = state.selected;
    if (!session || state.messageOffset === 0) return;
    await loadSafe(async () => {
      const offset = Math.max(0, state.messageOffset - 60);
      const body = await api(`/sessions/${encodeURIComponent(session.id)}/messages?limit=60&offset=${offset}`);
      if (state.profile !== session.profile || state.selected?.id !== session.id) return;
      const feed = main.querySelector('.chat-scroll'), height = feed?.scrollHeight || 0, position = feed?.scrollTop || 0;
      state.messages = [...dataArray(body, 'messages', 'items', 'data'), ...state.messages];
      state.messageOffset = offset; render();
      if (feed?.isConnected) feed.scrollTop = position + feed.scrollHeight - height;
    });
  }
  function markdownInline(value) {
    const node = el('span'); const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/g;
    let last = 0; let match;
    while ((match = pattern.exec(value)) !== null) {
      if (match.index > last) node.append(document.createTextNode(value.slice(last, match.index)));
      const token = match[0];
      if (token.startsWith('`')) node.append(text('code', token.slice(1, -1)));
      else if (token.startsWith('**')) node.append(text('strong', token.slice(2, -2)));
      else if (token.startsWith('*')) node.append(text('em', token.slice(1, -1)));
      else {
        const parts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token); const href = safeLink(parts[2]);
        node.append(href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', text: parts[1] }) : document.createTextNode(parts[1]));
      }
      last = pattern.lastIndex;
    }
    if (last < value.length) node.append(document.createTextNode(value.slice(last)));
    return node;
  }
  function markdownNode(source) {
    const body = el('div', { class: 'markdown' }); let code = null; let list = null;
    for (const line of String(source || '').split('\n')) {
      if (/^```/.test(line)) {
        if (code) { body.append(el('pre', {}, [code])); code = null; } else code = text('code', '');
        list = null; continue;
      }
      if (code) { code.textContent += `${line}\n`; continue; }
      const heading = /^(#{1,3})\s+(.+)$/.exec(line);
      if (heading) { body.append(el(`h${heading[1].length + 2}`, {}, [markdownInline(heading[2])])); list = null; continue; }
      const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
      if (bullet) { if (!list) { list = el('ul'); body.append(list); } list.append(el('li', {}, [markdownInline(bullet[1])])); continue; }
      list = null;
      if (/^>\s?/.test(line)) body.append(el('blockquote', {}, [markdownInline(line.replace(/^>\s?/, ''))]));
      else if (line.trim()) body.append(el('p', {}, [markdownInline(line)]));
      else body.append(el('div', { class: 'markdown-spacer' }));
    }
    if (code) body.append(el('pre', {}, [code]));
    return body;
  }
  function messageNode(message) {
    const role = message.role === 'user' ? 'user' : message.role === 'tool' ? 'tool' : 'assistant';
    const label = role === 'user' ? '你' : role === 'tool' ? '工具' : 'Hermes';
    const body = markdownNode(serverText(message));
    const article = el('article', { class: `message ${role}` }, [text('span', label, 'role'), body]);
    if (role === 'assistant' && serverText(message)) article.append(button('朗讀', () => speakText(serverText(message)), 'quiet-button small'));
    return article;
  }
  function renderChat() {
    const session = state.selected; if (!session) { state.tab = 'sessions'; return render(); }
    const layout = el('section', { class: 'chat-layout', 'data-session': scopedSessionKey(session) });
    layout.append(heading(session.title || '新對話', `${session.profile} · ${session.model || '目前模型'}`, [
      button('返回', () => switchTab('sessions'), 'quiet-button small'),
    ]));
    const stop = button('停止', stopRun, 'danger-button small chat-stop', state.run !== 'running');
    layout.append(row([button('模型', showModelPicker, 'soft-button small'),
      button('思考', showReasoningPicker, 'quiet-button small'), button('專案', showProjectPicker, 'quiet-button small'),
      button('同步', () => recoverSession(), 'quiet-button small'), stop]));
    const feed = el('div', { class: 'chat-scroll', tabindex: '0', 'aria-label': '對話記錄' });
    const jump = button('回到最新訊息 ↓', () => { feed.scrollTop = feed.scrollHeight; jump.hidden = true; }, 'soft-button small chat-jump');
    jump.hidden = true;
    feed.addEventListener('scroll', () => { jump.hidden = feed.scrollHeight - feed.clientHeight - feed.scrollTop < 100; });
    feed.append(el('div', { class: 'chat-history' }), el('div', { class: 'chat-stream' }),
      el('div', { class: 'chat-tools' }), el('div', { class: 'chat-requests', 'aria-label': '待你確認' }));
    layout.append(el('div', { class: 'chat-status', role: 'status' }), feed, jump);
    const [composerWrap, composer] = field('訊息', 'textarea', draftFor(session), '想說什麼？');
    composer.addEventListener('input', () => saveDraft(state.selected, composer.value));
    const attached = el('div', { class: 'attachments' });
    const fileInput = el('input', { type: 'file', multiple: '', hidden: '', on: { change: event => {
      for (const file of event.target.files || []) state.attachments.push(file);
      render();
    } } });
    const tools = row([button('＋ 附件', () => fileInput.click(), 'quiet-button small'),
      button('工作區檔案', () => showWorkspacePicker(), 'quiet-button small'),
      button(state.recorder ? '完成錄音' : '語音輸入', () => startSpeech(composer), 'quiet-button small'),
      button('送出', () => submitPrompt(composer), 'button chat-send', !canSubmitTurn(state.run, state.sendAttempted, session, state.profile))]);
    layout.append(el('div', { class: 'composer' }, [composerWrap, attached, fileInput, tools]));
    main.append(layout); updateChat(true);
  }
  function updateChat(first = false) {
    const layout = main.querySelector('.chat-layout'); if (!layout || !state.selected) return;
    const feed = layout.querySelector('.chat-scroll');
    const follow = first || feed.scrollHeight - feed.clientHeight - feed.scrollTop < 100;
    const position = feed.scrollTop;
    const history = layout.querySelector('.chat-history');
    const signature = JSON.stringify([state.messageOffset, state.messages]);
    if (history._signature !== signature) {
      history._signature = signature; history.replaceChildren();
      if (state.messageOffset > 0) history.append(button('載入更早訊息', loadOlderMessages, 'quiet-button small'));
      for (const message of state.messages) history.append(messageNode(message));
      if (!state.messages.length && !state.streamed) history.append(text('p', '在這裡開始聊吧。', 'empty'));
    }
    const streamed = layout.querySelector('.chat-stream');
    const streamSignature = JSON.stringify([state.streamed, state.reasoning]);
    if (streamed._signature !== streamSignature) {
      streamed._signature = streamSignature; streamed.replaceChildren();
      if (state.reasoning) streamed.append(el('details', { class: 'tool-card' }, [text('summary', '思考過程'), text('div', state.reasoning)]));
      if (state.streamed) streamed.append(messageNode({ role: 'assistant', text: state.streamed }));
    }
    const tools = layout.querySelector('.chat-tools');
    const toolSignature = JSON.stringify(state.toolCards.slice(-8));
    if (tools._signature !== toolSignature) {
      tools._signature = toolSignature; tools.replaceChildren(...state.toolCards.slice(-8).map(tool =>
        el('details', { class: 'tool-card' }, [text('summary', tool.name || '工具'), text('div', tool.preview || tool.status || '')])));
    }
    const requests = layout.querySelector('.chat-requests');
    const active = new Map([...state.pending].filter(([, request]) => request.runtimeId === state.selected.runtimeId && request.profile === state.selected.profile));
    for (const node of [...requests.children]) if (!active.has(node._requestKey)) node.remove();
    for (const [key, request] of active) {
      let node = [...requests.children].find(node => node._requestKey === key);
      const version = requestContentKey(request);
      if (!node || node._requestVersion !== version) {
        const replacement = requestCard(request); replacement._requestKey = key; replacement._requestVersion = version;
        if (node) node.replaceWith(replacement); else requests.append(replacement);
      }
    }
    const status = layout.querySelector('.chat-status');
    status.textContent = state.run === 'uncertain' ? '送出狀態待確認。按「同步」查原操作，不會自動重送。' :
      active.size ? `有 ${active.size} 項待你確認，請往下查看。` : state.run === 'running' ? '正在處理…你可以閱讀舊訊息。' : state.run === 'preparing' ? '正在準備訊息…' : '';
    status.classList.toggle('status', Boolean(status.textContent));
    layout.querySelector('.chat-send').disabled = !canSubmitTurn(state.run, state.sendAttempted, state.selected, state.profile);
    layout.querySelector('.chat-stop').disabled = state.run !== 'running';
    const composer = layout.querySelector('.composer textarea');
    const draft = draftFor(state.selected); if (composer.value !== draft) composer.value = draft;
    const attached = layout.querySelector('.attachments');
    const attachmentSignature = state.attachments.map(file => `${file.name}:${file.size}:${file.lastModified}`).join('|');
    if (attached._signature !== attachmentSignature) {
      attached._signature = attachmentSignature; attached.replaceChildren(...state.attachments.map((file, index) => button(`${file.name} ×`, () => {
        state.attachments.splice(index, 1); render();
      }, 'attachment-chip')));
    }
    if (follow) feed.scrollTop = feed.scrollHeight; else feed.scrollTop = position;
    layout.querySelector('.chat-jump').hidden = follow;
  }
  async function startSpeech(input) {
    if (state.sttMode === 'server') return startServerSpeech();
    if (window.HermesNative?.postMessage) return loadSafe(async () => {
      const result = await nativeCall('startListening', { locale: 'zh-TW' });
      if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('沒有辨識到語音');
      input.value = `${input.value}${input.value ? '\n' : ''}${result.text}`;
      saveDraft(state.selected, input.value);
    });
    const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Speech) return notice('這台裝置的瀏覽器沒有提供語音辨識，請用鍵盤輸入。');
    const recognition = new Speech(); recognition.lang = 'zh-TW'; recognition.interimResults = false;
    recognition.onresult = event => { input.value = `${input.value}${input.value ? '\n' : ''}${event.results[0][0].transcript}`;
      saveDraft(state.selected, input.value); };
    recognition.onerror = () => notice('這次沒有辨識到語音，原本的文字已保留。');
    recognition.start(); notice('正在聽你說話。語音辨識依瀏覽器與裝置支援。');
  }
  async function startServerSpeech() {
    if (state.recorder) { state.recorder.stop(); return; }
    await loadSafe(async () => {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('此瀏覽器無法錄音。');
      const session = state.selected; if (!session) throw new Error('請先打開對話。');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ['audio/mp4', 'audio/webm', 'audio/ogg'].find(mime => MediaRecorder.isTypeSupported(mime));
      const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks = [];
      recorder.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data); });
      recorder.addEventListener('stop', () => loadSafe(async () => {
        stream.getTracks().forEach(track => track.stop()); state.recorder = null; render();
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        if (!blob.size || blob.size > 8 * 1024 * 1024) throw new Error('錄音為空或超過 8 MiB。');
        const file = new File([blob], 'voice', { type: blob.type });
        const result = await api('/audio/transcribe', { method: 'POST', body: {
          data_url: await fileToDataURL(file), mime_type: blob.type } });
        if (!result.ok && result.ok !== undefined) throw new Error(result.message || '聽寫未完成');
        const transcript = result.transcript || result.text;
        if (typeof transcript !== 'string' || !transcript.trim()) throw new Error('沒有辨識到語音');
        if (state.profile !== session.profile || state.selected?.id !== session.id) throw new Error('對話已切換，語音未放入草稿。');
        const previous = draftFor(session); saveDraft(session, `${previous}${previous ? '\n' : ''}${transcript}`);
        render(); notice('語音已放入草稿，請確認後送出。');
      }));
      recorder.start(); state.recorder = recorder; render(); notice('正在錄音；按「完成錄音」送到已設定的伺服器聽寫。');
      setTimeout(() => { if (state.recorder === recorder && recorder.state === 'recording') recorder.stop(); }, 15000);
    });
  }
  function speakText(value) {
    if (state.ttsMode === 'server') return loadSafe(async () => {
      if (state.speechAudio) state.speechAudio.pause();
      const result = await api('/audio/speak', { method: 'POST', body: { text: value.slice(0, 8000) } });
      if (!result.ok && result.ok !== undefined) throw new Error(result.message || '語音合成未完成');
      if (!/^data:audio\/[\w.+-]+;base64,/.test(result.data_url || '')) throw new Error('伺服器沒有返回可播放語音');
      const audio = new Audio(result.data_url); state.speechAudio = audio;
      audio.addEventListener('ended', () => { if (state.speechAudio === audio) state.speechAudio = null; }, { once: true });
      await audio.play();
    });
    if (window.HermesNative?.postMessage) return loadSafe(() => nativeCall('speak', { text: value.slice(0, 12000) }));
    if (!window.speechSynthesis) return notice('這台裝置目前無法朗讀。');
    window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(value.slice(0, 12000));
    utterance.lang = 'zh-TW'; window.speechSynthesis.speak(utterance);
  }
  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('無法讀取附件')); reader.readAsDataURL(file);
    });
  }
  async function showWorkspacePicker(path = '') {
    await loadSafe(async () => {
      const profile = state.profile; const body = await api(`/files${path ? `?path=${encodeURIComponent(path)}` : ''}`);
      if (profile !== state.profile || state.tab !== 'chat') return;
      const panel = card([text('h2', '從工作區選檔案'), text('p', body.path || '工作區')]);
      panel.append(button('返回對話', render, 'quiet-button small'));
      if (body.parent) panel.append(button('上一層', () => showWorkspacePicker(body.parent), 'quiet-button small'));
      for (const entry of dataArray(body, 'entries')) panel.append(button(
        `${entry.is_directory ? '資料夾' : '檔案'} · ${entry.name || entry.path}`,
        () => entry.is_directory ? showWorkspacePicker(entry.path) : loadSafe(async () => {
          const doc = await api(`/files/read?path=${encodeURIComponent(entry.path)}`);
          if (profile !== state.profile || state.tab !== 'chat') return;
          const bytes = decodeDataURL(doc.data_url);
          if (bytes.length > 16 * 1024 * 1024) throw new Error('檔案超過 16 MiB，無法作為附件。');
          state.attachments.push(new File([bytes], doc.name || entry.name || 'workspace-file',
            { type: doc.mime_type || 'application/octet-stream' }));
          render(); notice('已加入附件；送出前可移除。');
        }), 'quiet-button small'));
      clear(); main.append(panel);
    });
  }
  async function prepareAttachments(session) {
    const additions = [];
    for (const file of state.attachments) {
      if (file.size > 16 * 1024 * 1024) throw new Error(`${file.name} 超過 16 MiB`);
      const dataUrl = await fileToDataURL(file);
      if (file.type.startsWith('image/')) {
        await rpc('image.attach_bytes', { session_id: session.runtimeId, profile: session.profile,
          content_base64: dataUrl, filename: file.name });
      } else {
        const root = session.workspacePath;
        if (!root || !root.startsWith('/')) throw new Error('先選擇伺服器專案，才能傳送一般檔案。');
        const safeName = file.name.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(-90) || 'attachment';
        const path = `${root.replace(/\/$/, '')}/hermes-share-${crypto.randomUUID()}-${safeName}`;
        await api('/files/upload', { method: 'POST', body: { path, data_url: dataUrl,
          overwrite: false, profile: session.profile } });
        const check = await api(`/files/read?path=${encodeURIComponent(path)}`);
        if (check.path !== path || !equalBytes(decodeDataURL(check.data_url), decodeDataURL(dataUrl)))
          throw new Error('附件讀回不一致；訊息尚未送出。');
        additions.push(`\n\n--- 附件：${file.name} ---\n伺服器檔案路徑：${JSON.stringify(path)}\n請使用檔案工具讀取。\n--- 附件結束 ---`);
      }
    }
    return additions.join('');
  }
  async function submitPrompt(composer) {
    const session = state.selected; const prompt = composer.value.trim();
    if (!session || (!prompt && !state.attachments.length)) return;
    if (!canSubmitTurn(state.run, state.sendAttempted, session, state.profile))
      return notice('先等這段對話完成或同步狀態。');
    const attemptKey = scopedSessionKey(session);
    const stillSelected = () => state.selected && scopedSessionKey(state.selected) === attemptKey;
    let submitted = false;
    state.run = 'preparing'; render();
    try {
      if (!session.fresh) {
        const resumed = await rpc('session.resume', { session_id: session.id, profile: session.profile,
          cols: 72, source: 'mobile-web' });
        if (resumed.running) throw new Error('這段對話已有任務在執行，請先同步。');
        session.runtimeId = resumed.session_id;
      }
      if (state.profile !== session.profile || state.selected?.id !== session.id) return;
      if (session.workspacePath) await rpc('session.cwd.set', { session_id: session.runtimeId,
        cwd: session.workspacePath, profile: session.profile });
      const attachments = await prepareAttachments(session);
      if (state.profile !== session.profile || state.selected?.id !== session.id) return;
      const textToSend = prompt + attachments;
      const submissionId = crypto.randomUUID();
      state.turnAttempts.set(scopedSessionKey(session), { id: submissionId, draft: prompt });
      submitted = true; state.sendAttempted = true; state.streamStarted = false; state.run = 'running'; state.streamed = ''; state.reasoning = '';
      session.fresh = false;
      state.messages.push({ role: 'user', text: prompt || '[附件]' });
      state.attachments = []; clearDraft(session); render();
      // The BFF removes client_submission_id before forwarding and persists it to prevent duplicates.
      await rpc('prompt.submit', { session_id: session.runtimeId, profile: session.profile,
        text: textToSend, client_submission_id: submissionId }, 120000);
      state.turnAttempts.delete(attemptKey);
      if (!stillSelected()) return;
      state.sendAttempted = false;
      for (const key of state.shareDraftIds) {
        try { await shareStore('delete', key); } catch { notice('訊息已送出，分享草稿清理失敗；可手動刪除。'); }
      }
      state.shareDraftIds = [];
      await loadShareInbox().catch(showError);
    } catch (error) {
      if (!stillSelected()) return;
      if (submitted) {
        state.run = 'uncertain'; notice('送出狀態待確認。請按「同步」查原對話；不會自動重送。');
      } else { state.run = 'idle'; showError(error); }
      render();
    }
  }
  async function stopRun() {
    const session = state.selected; if (!session?.runtimeId) return;
    await loadSafe(async () => { await rpc('session.interrupt', { session_id: session.runtimeId, profile: session.profile });
      notice('已請 Hermes 停止，稍後同步結果。'); });
  }
  async function loadModels() {
    const body = await api('/model/options?explicit_only=1'); state.models = body; return body;
  }
  async function readySession(session) {
    const resumed = await rpc('session.resume', { session_id: session.id,
      profile: session.profile, cols: 72, source: 'mobile-web' });
    const reasoning = await rpc('config.get', { session_id: resumed.session_id,
      profile: session.profile, key: 'reasoning' });
    if (state.profile === session.profile && state.selected?.id === session.id)
      state.selected = selectionFromInfo(session, resumed, reasoning.value);
    return resumed;
  }
  async function assertSelectionIdle(session) {
    const resumed = await readySession(session);
    const status = await rpc('session.status', { session_id: resumed.session_id, profile: session.profile });
    if (resumed.running || status.running || /Agent Running: Yes/i.test(status.output || ''))
      throw new Error('對話正在執行，完成後再切換。');
    if (state.profile !== session.profile || state.selected?.id !== session.id)
      throw new Error('目前已切換到其他對話。');
    return resumed;
  }
  async function showModelPicker() {
    const body = await loadSafe(loadModels); if (!body) return;
    const providers = dataArray(body, 'providers').filter(provider => provider.authenticated !== false);
    const panel = card([text('h2', '這段對話的模型'), text('p', '選定後只影響目前對話。')]);
    for (const provider of providers) {
      panel.append(text('div', provider.name || provider.slug, 'subhead'));
      for (const model of provider.models || []) panel.append(button(model, async () => {
        const session = state.selected;
        await loadSafe(async () => {
          const resumed = await assertSelectionIdle(session);
          const params = { session_id: resumed.session_id, profile: session.profile,
            scope: 'session', key: 'model', value: `${model} --provider ${provider.slug} --session` };
          const apply = async (confirmed = false) => {
            const result = await rpc('config.set', { ...params, confirm_expensive_model: confirmed }, 120000);
            if (result.confirm_required) {
              const confirmPanel = card([text('h2', '確認模型切換'),
                text('p', result.confirm_message || result.warning || '此模型需要額外確認。'),
                button('確認切換', () => loadSafe(async () => {
                  await assertSelectionIdle(session); await apply(true);
                }), 'primary-button'), button('取消', render, 'soft-button')]);
              clear(); main.append(confirmPanel); return;
            }
            if (result.scope && result.scope !== 'session') throw new Error('伺服器未確認單段對話設定。');
            await readySession({ ...session, runtimeId: resumed.session_id });
            const confirmedSelection = state.selected?.model === model && state.selected?.provider === provider.slug;
            render(); notice(confirmedSelection ? '已查回這段對話的模型設定。' :
              '切換指令已送出，伺服器尚未回傳相同模型；請稍後同步核對。');
          };
          await apply();
        });
      }, 'quiet-button small'));
    }
    panel.append(button('關閉', render, 'soft-button small')); clear(); main.append(panel);
  }
  async function showReasoningPicker() {
    const current = state.selected; if (!current) return;
    const body = await loadSafe(loadModels); if (!body) return;
    const resumed = await loadSafe(() => readySession(current)); if (!resumed) return;
    const session = state.selected;
    const options = reasoningChoices(body, session);
    const labels = REASONING_LABELS;
    const panel = card([text('h2', '這段對話的思考程度'),
      text('p', options.length ? `目前：${labels[session.reasoningEffort] || session.reasoningEffort || '預設'}` :
        '目前模型未提供可選的思考程度。')]);
    if (options.length) panel.append(text('small', '部分模型會按自身支援範圍調整思考程度。'));
    for (const effort of options) panel.append(button(labels[effort], async () => {
      await loadSafe(async () => {
        const ready = await assertSelectionIdle(session);
        await rpc('config.set', { session_id: ready.session_id, profile: session.profile,
          scope: 'session', key: 'reasoning', value: effort });
        await readySession({ ...session, runtimeId: ready.session_id });
        render(); notice(state.selected?.reasoningEffort === effort ? '已查回這段對話的思考設定。' :
          '設定已送出，伺服器尚未回傳相同狀態；請稍後同步。');
      });
    }, 'quiet-button small'));
    panel.append(button('返回對話', render, 'soft-button small')); clear(); main.append(panel);
  }
  async function showProjectPicker() {
    await loadSafe(async () => {
      const body = await rpc('projects.list', { profile: state.profile });
      state.projects = dataArray(body, 'projects');
      const panel = card([text('h2', '選擇工作專案')]);
      for (const project of state.projects) {
        const path = project.primary_path || project.primaryPath || project.paths?.[0];
        if (!path) continue;
        panel.append(el('button', { class: 'list-item', type: 'button', on: { click: async () => {
          await loadSafe(async () => {
            const session = state.selected;
            const resumed = await readySession(session);
            if (resumed.running) throw new Error('對話執行中，完成後再切換專案。');
            await rpc('session.cwd.set', { session_id: resumed.session_id, cwd: path, profile: session.profile });
            state.selected = { ...session, runtimeId: resumed.session_id, workspacePath: path }; render();
            notice('已選擇工作專案。');
          });
        } } }, [text('strong', project.name || project.label || path), text('small', path)]));
      }
      panel.append(button('返回對話', render, 'soft-button small')); clear(); main.append(panel);
    });
  }
  function connectSocket() {
    if (!state.csrf || !state.me?.authenticated || [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.ws?.readyState)) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/mobile/ws?csrf=${encodeURIComponent(state.csrf)}`;
    const socket = new WebSocket(url); state.ws = socket; state.wsReady = false; state.protocolReady = false; state.capabilityPromise = null;
    setConnection('正在連線');
    socket.addEventListener('open', () => setConnection('正在確認連線'));
    socket.addEventListener('message', event => {
      if (state.ws !== socket) return;
      let frame; try { frame = JSON.parse(event.data); } catch { return; }
      if (frame.id !== undefined && state.rpcCalls.has(String(frame.id))) {
        const call = state.rpcCalls.get(String(frame.id)); state.rpcCalls.delete(String(frame.id));
        clearTimeout(call.timer);
        if (frame.error) { const error = new Error(frame.error.message || 'Gateway 請求失敗'); error.code = frame.error.code; call.reject(error); }
        else call.resolve(frame.result || {});
        return;
      }
      if (frame.method === 'event' || frame.method === 'gateway.event' || frame.params?.type) {
        handleEvent(frame.params || {}); return;
      }
      if (frame.method === 'approval' || frame.method === 'clarify') {
        handleServerRequest(frame); return;
      }
    });
    socket.addEventListener('close', () => {
      if (state.ws !== socket) return;
      state.wsReady = false; state.protocolReady = false; state.capabilityPromise = null; state.streamStarted = false; setConnection(navigator.onLine ? '連線中斷' : '離線');
      for (const [id, call] of state.rpcCalls) {
        clearTimeout(call.timer); call.reject(new Error('連線中斷，請同步原對話確認結果')); state.rpcCalls.delete(id);
      }
      if (state.run === 'running') state.run = 'uncertain';
      if (state.selected) state.selected.fresh = false;
      for (const [key, request] of state.pending) if (request.serverId !== null) state.pending.delete(key);
      if (state.me?.authenticated) setTimeout(connectSocket, 2500);
      if (state.tab === 'chat') render();
    });
    socket.addEventListener('error', () => setConnection('連線發生問題'));
  }
  function rpc(method, params = {}, timeout = 30000) {
    if (!state.wsReady || state.ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('即時連線尚未建立'));
    if (method !== 'client.capabilities' && !state.protocolReady && state.capabilityPromise) {
      const socket = state.ws;
      return state.capabilityPromise.then(() => {
        if (state.ws !== socket || !state.protocolReady) throw new Error('連線已更換，請同步原對話');
        return rpc(method, params, timeout);
      });
    }
    return new Promise((resolve, reject) => {
      if (!state.wsReady || state.ws?.readyState !== WebSocket.OPEN) return reject(new Error('即時連線尚未建立'));
      const id = `mobile-${++state.requestSerial}`;
      const timer = setTimeout(() => { state.rpcCalls.delete(id); reject(new Error(`${method} 等待回覆逾時`)); }, timeout);
      state.rpcCalls.set(id, { resolve, reject, timer });
      try { state.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method,
        params: { ...params, profile: params.profile || state.profile } })); }
      catch (error) { clearTimeout(timer); state.rpcCalls.delete(id); reject(error); }
    });
  }
  function mergeRequests(requests, runtimeId) {
    if (!Array.isArray(requests)) return;
    for (const [key, request] of state.pending) if (request.runtimeId === runtimeId) state.pending.delete(key);
    for (const request of requests) {
      if (!request || typeof request !== 'object') continue;
      if (request.method === 'approval' || request.method === 'clarify') {
        if (String(request.params?.session_id || '') === runtimeId) handleServerRequest(request);
        continue;
      }
      const key = String(request.request_id || request.id || ''); if (!key) continue;
      state.pending.set(key, { key, runtimeId, profile: state.profile,
        type: request.type || request.method || 'approval', title: request.title || request.prompt || '待你確認',
        details: request.description || request.message || '', choices: request.choices || [],
        serverId: request.server_request_id ?? null, questionId: request.question_id || '' });
    }
    if (state.tab === 'tasks' || state.tab === 'chat') render();
  }
  function handleServerRequest(frame) {
    const params = frame.params || {};
    const runtimeId = String(params.session_id || params.payload?.session_id || '');
    const id = String(frame.id ?? '');
    if (!runtimeId || !id) return;
    if (frame.method === 'clarify' && Array.isArray(params.questions)) {
      for (const question of params.questions) {
        if (!question?.qid || params.answers?.[question.qid] !== undefined) continue;
        const key = `${id}:${question.qid}`;
        state.pending.set(key, { key, runtimeId, profile: params.profile || state.profile,
          type: 'clarify', title: question.question || '待你回答', details: params.description || '',
          choices: question.choices || [], multiSelect: Boolean(question.multi_select),
          serverId: frame.id, questionId: question.qid });
      }
    } else if (frame.method === 'approval') {
      state.pending.set(id, { key: id, runtimeId, profile: params.profile || state.profile,
        type: 'approval', title: params.command || params.tool_name || '需要確認操作',
        details: params.description || '', choices: params.choices ||
          ['once', ...(params.smart_denied || params.allow_session === false ? [] : ['session']),
            ...(!params.smart_denied && params.allow_permanent ? ['always'] : []), 'deny'],
        serverId: frame.id, questionId: '' });
    }
    if (state.tab === 'tasks' || state.tab === 'chat') render();
  }
  function handleEvent(params) {
    const type = params.type;
    if (type === 'mobile.unsupported') {
      notice(params.payload?.message || '這項操作需要在原 Hermes 桌面介面處理。');
      return;
    }
    if (type === 'gateway.ready') {
      state.wsReady = true; setConnection('已連線');
      const socket = state.ws;
      state.capabilityPromise = rpc('client.capabilities', { server_requests: true }, 10000).catch(error => {
        if (error.code !== -32601) throw error;
      }).then(() => { if (state.ws !== socket) throw new Error('連線已更換'); state.protocolReady = true; });
      state.capabilityPromise.then(() => { if (state.selected) recoverSession(false); }).catch(error => { state.lastError = '確認協議尚未接通'; showError(error); });
      return;
    }
    const payload = params.payload || params;
    const runtimeId = String(params.session_id || payload.session_id || '');
    if (type === 'session.info' && state.selected?.runtimeId === runtimeId) {
      state.selected = selectionFromInfo(state.selected, { session_id: runtimeId, info: payload });
    }
    if (type === 'approval.request' || type === 'clarify.request') {
      const key = String(payload.request_id || payload.id || '');
      if (key && runtimeId) state.pending.set(key, { key, runtimeId, profile: payload.profile || state.profile,
        type: type.startsWith('approval') ? 'approval' : 'clarify',
        title: payload.title || payload.prompt || '待你確認', details: payload.description || payload.message || '',
        choices: payload.choices || [], serverId: null, questionId: payload.question_id || '' });
      if (state.tab === 'tasks' || state.tab === 'chat') render();
      return;
    }
    if (type === 'request.cancel' || /^(approval|clarify)\.expire(d)?$/.test(type)) {
      const parent = String(payload.request_id ?? payload.id ?? '');
      for (const [key, request] of state.pending) {
        if ((runtimeId && request.runtimeId !== runtimeId) || (payload.profile && request.profile !== payload.profile)) continue;
        if (parent && (String(request.serverId) === parent || key === parent)) {
          state.pending.delete(key); state.requestDrafts.delete(requestDraftKey(request));
        }
      }
      if (state.tab === 'tasks' || state.tab === 'chat') render(); return;
    }
    const session = state.selected;
    if (!session || session.runtimeId !== runtimeId) return;
    if (type === 'message.start') { state.run = 'running'; state.streamStarted = true; state.streamed = ''; state.reasoning = ''; render(); return; }
    if (type === 'message.delta' && state.streamStarted) state.streamed += String(payload.text || '');
    if (type === 'message.interim' && state.streamStarted && payload.text) state.streamed = String(payload.text);
    if (['reasoning.delta', 'thinking.delta'].includes(type) && state.streamStarted) state.reasoning += String(payload.text || '');
    if (type === 'tool.start' || type === 'tool.generating') state.toolCards.push({ name: payload.name || payload.tool_name,
      preview: payload.context || payload.preview || payload.args_text || '' });
    if (type === 'tool.complete') state.toolCards.push({ name: payload.name || payload.tool_name, status: '完成' });
    if (type === 'message.complete') {
      if (['error', 'failed', 'failure'].includes(payload.status)) notice(payload.error || '這次回覆失敗');
      state.run = 'idle'; state.sendAttempted = false;
      state.streamStarted = false;
      if (payload.text) state.streamed = String(payload.text);
      state.turnAttempts.delete(scopedSessionKey(session));
      render(); loadSafe(async () => {
        await loadMessages();
        if (state.selected?.id !== session.id || state.profile !== session.profile) return;
        state.streamed = ''; state.reasoning = ''; if (state.tab === 'chat') render();
      });
    }
    if (state.tab === 'chat' && type !== 'message.complete') render();
  }
  async function answerRequest(request, choice) {
    await loadSafe(async () => {
      if (state.profile !== request.profile || !state.pending.has(request.key) || state.pending.get(request.key)?.runtimeId !== request.runtimeId ||
          requestContentKey(state.pending.get(request.key)) !== requestContentKey(request))
        throw new Error('這項請求已變動，請重新核對。');
      if (request.serverId !== null) {
        if (!state.wsReady) throw new Error('先恢復連線並重新核對這項請求。');
        if (request.type === 'approval') {
          state.ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.serverId, result: { choice } }));
        } else {
          const result = await rpc('clarify.lock', { request_id: String(request.serverId), question_id: request.questionId,
            answer: choice, profile: request.profile });
          if (result.status === 'expired') throw new Error('這個問題已過期，請重新核對。');
          if (result.status !== 'ok') throw new Error('回答結果不明，請回原對話核對後再操作。');
        }
      } else {
        const isApproval = request.type.includes('approval');
        await rpc(isApproval ? 'approval.respond' : 'clarify.respond', legacyRequestParams(request, choice));
      }
      const draft = state.requestDrafts.get(requestDraftKey(request));
      if (request.type === 'approval' && request.serverId !== null) {
        if (draft) draft.uncertain = true;
        notice('選擇已送出，正在核對…');
        await recoverSession(false);
      } else {
        state.pending.delete(request.key); state.requestDrafts.delete(requestDraftKey(request));
        notice('已送出你的回答。');
      }
      render();
    });
  }
  async function refreshTasks() {
    await loadSafe(async () => {
      const profile = state.profile;
      const [body, sessions] = await Promise.all([api('/cron/jobs'),
        api('/sessions?limit=100&offset=0&include_children=false&order=recent')]);
      if (state.profile !== profile) return;
      state.cron = dataArray(body, 'jobs', 'items', 'data');
      state.taskSessions = dataArray(sessions, 'sessions', 'items', 'data').filter(item =>
        item?.id && (!item.profile || item.profile === profile) && ['cron', 'task'].includes(String(item.source || '').toLowerCase()));
      try {
        const active = await rpc('session.active_list', { profile });
        if (state.profile !== profile) return;
        state.activeRuns = dataArray(active, 'sessions').filter(row => row?.stored_session_id && row.profile === profile);
        state.activeRunsComplete = active.scope_complete === true;
      } catch { state.activeRuns = []; state.activeRunsComplete = false; }
      if (state.selected) await recoverSession(false);
      if (state.tab === 'tasks') render();
    });
  }
  function requestContentKey(request) {
    return JSON.stringify([request.type, request.title, request.details, request.choices, request.multiSelect,
      request.serverId, request.questionId]);
  }
  function requestDraftKey(request) { return `${request.profile}::${request.runtimeId}::${request.key}::${requestContentKey(request)}`; }
  function requestCard(request) {
    const draftKey = requestDraftKey(request);
    let draft = state.requestDrafts.get(draftKey);
    if (!draft) { draft = { selected: [], answer: '', submitting: false, uncertain: false }; state.requestDrafts.set(draftKey, draft); }
    const panel = card([text('span', request.type === 'approval' ? '操作確認' : '待你回答', 'pill'),
      text('h2', request.title), text('p', request.details || '請確認這項操作。', 'request-details')], 'request-card');
    const choices = dataArray(request.choices, 'choices');
    const labels = { once: '允許一次', session: '這段對話允許', always: '一律允許', deny: '拒絕' };
    const options = choices.length ? choices.map(choice => {
      const value = typeof choice === 'string' ? choice : choice.value || choice.id || String(choice);
      return { label: typeof choice === 'string' ? labels[choice] || choice : choice.label || choice.title || labels[value] || value, value };
    }) : request.type === 'approval' ? [{ label: '允許一次', value: 'once' }, { label: '拒絕', value: 'deny' }] : [];
    const answer = () => request.multiSelect ? [...draft.selected, draft.answer.trim()].filter(Boolean).join(', ') : draft.answer.trim() || draft.selected[0] || '';
    const submit = button(request.type === 'approval' ? '確認並繼續' : '送出回答', async () => {
      if (!answer() || draft.submitting || draft.uncertain) return;
      draft.submitting = true; syncControls();
      try { await answerRequest(request, answer()); }
      finally { draft.submitting = false; if (panel.isConnected) syncControls(); }
    }, 'button');
    const inputs = [];
    function syncControls() {
      submit.disabled = !answer() || draft.submitting || draft.uncertain;
      submit.textContent = draft.uncertain ? '已送出，等待核對' : draft.submitting ? '正在送出…' : request.type === 'approval' ? '確認並繼續' : '送出回答';
      for (const input of inputs) input.disabled = draft.submitting || draft.uncertain;
    }
    for (const option of options) {
      const input = el('input', { type: request.multiSelect ? 'checkbox' : 'radio', name: encodeURIComponent(draftKey), value: option.value });
      input.checked = draft.selected.includes(option.value);
      input.addEventListener('change', () => {
        draft.selected = request.multiSelect ? input.checked ? [...draft.selected.filter(value => value !== option.value), option.value] : draft.selected.filter(value => value !== option.value) : [option.value];
        if (!request.multiSelect) draft.answer = '';
        syncControls();
      });
      inputs.push(input); panel.append(el('label', { class: 'request-choice' }, [input, text('span', option.label)]));
    }
    if (request.type === 'clarify') {
      const [wrap, input] = field(options.length ? '其他／補充回答' : '你的回答', 'textarea', draft.answer);
      input.addEventListener('input', () => { draft.answer = input.value; syncControls(); });
      inputs.push(input); panel.append(wrap);
    }
    panel.append(row([button('重新核對', async () => { if (state.selected) await recoverSession(); else notice('請打開原對話核對。'); }, 'quiet-button small'), submit]));
    syncControls(); return panel;
  }
  function cronCard(job) {
    const id = job.id || job.job_id; const enabled = job.enabled !== undefined ? job.enabled : !job.paused;
    const schedule = typeof job.schedule === 'string' ? job.schedule :
      job.schedule?.display || job.schedule?.expr || job.schedule?.expression || '';
    return card([text('h2', job.name || job.title || '定時任務'),
      text('p', `${schedule}${job.next_run_at ? ` · 下次 ${job.next_run_at}` : ''}`),
      row([button('詳情', () => showCronDetail(id), 'quiet-button small'),
        button('編輯', () => editCron(job), 'quiet-button small'),
        button(enabled ? '暫停' : '恢復', () => cronAction(id, enabled ? 'pause' : 'resume'), 'soft-button small'),
        button('立即執行', () => cronAction(id, 'trigger'), 'quiet-button small'),
        button('刪除', () => deleteCron(id), 'danger-button small')])]);
  }
  function renderTasks() {
    main.append(heading('任務', '把約好的事，穩穩接住', [
      button('刷新', refreshTasks, 'text-button'), button('＋', () => editCron(null), 'soft-button small')]));
    main.append(el('div', { class: 'task-tabs' }, [['current', '進行中'], ['scheduled', '定時安排'], ['completed', '已完成']].map(([key, label]) =>
      button(label, () => { state.taskView = key; render(); }, state.taskView === key ? 'soft-button small' : 'quiet-button small'))));
    if (state.taskView === 'current') {
      if (state.pending.size) for (const request of state.pending.values()) main.append(requestCard(request));
      if (state.activeRuns.length) main.append(text('div', '已核對的執行中對話', 'subhead'));
      for (const run of state.activeRuns) main.append(card([text('h2', run.title || '執行中對話'),
        button('查看處理詳情', () => openSession({ id: run.stored_session_id, profile: run.profile,
          title: run.title || '執行中對話' }), 'soft-button small')]));
      if (!state.activeRunsComplete) main.append(text('p', '僅顯示已核對的執行中對話；清單可能不完整。', 'muted'));
      if (state.selected && state.run === 'running') main.append(card([text('h2', state.selected.title || '正在處理'),
        row([button('查看處理詳情', () => { state.tab = 'chat'; render(); }, 'soft-button small'),
          button('停止', stopRun, 'danger-button small')])]));
      for (const job of state.cron.filter(item => /running/i.test(item.state || item.status || ''))) main.append(cronCard(job));
      if (!state.pending.size && !state.activeRuns.length && state.run !== 'running' &&
          !state.cron.some(item => /running/i.test(item.state || item.status || '')))
        main.append(text('p', '目前沒有已查回的進行中事項。', 'empty'));
    } else if (state.taskView === 'scheduled') {
      main.append(button('新增定時任務', () => editCron(null), 'button small'));
      if (!state.cron.length) main.append(text('p', '目前沒有定時任務。', 'empty'));
      else state.cron.forEach(job => main.append(cronCard(job)));
    } else {
      const history = state.cron.filter(job => job.last_run_at);
      if (!history.length && !state.taskSessions.length) main.append(text('p', '目前沒有可查回的完成記錄。', 'empty'));
      for (const session of state.taskSessions) main.append(el('button', { class: 'list-item', type: 'button',
        on: { click: () => openSession(session) } }, [text('span', '◷', 'glyph'),
        el('span', { class: 'grow' }, [text('strong', session.title || '任務對話'), text('small', session.preview || session.updated_at || '')])]));
      if (!state.taskSessions.some(session => String(session.source || '').toLowerCase() === 'cron'))
        for (const job of history) main.append(card([text('h2', job.name || '定時任務'),
          text('p', `最近執行：${job.last_run_at} · ${job.last_status || '狀態未知'}`),
          button('查看任務', () => showCronDetail(job.id || job.job_id), 'quiet-button small')]));
    }
  }
  async function showCronDetail(id) {
    await loadSafe(async () => {
      const profile = state.profile; const body = await api(`/cron/jobs/${encodeURIComponent(id)}`);
      if (profile !== state.profile) return;
      const job = body.job || body;
      const panel = card([text('h2', job.name || '定時任務'),
        text('p', `排程：${typeof job.schedule === 'string' ? job.schedule : job.schedule?.expr || job.schedule?.display || '未提供'}`),
        text('p', `狀態：${job.status || job.state || (job.enabled ? '已啟用' : '已暫停')}`),
        text('p', `下次：${job.next_run_at || '未提供'} · 最近：${job.last_run_at || '未執行'}`),
        text('p', `最近結果：${job.last_status || '未提供'}`),
        text('p', job.prompt || '', 'document'),
        row([button('返回任務', render, 'quiet-button small'), button('編輯', () => editCron(job), 'soft-button small')])]);
      clear(); main.append(panel);
    });
  }
  function editCron(job) {
    const [nameWrap, name] = field('名稱', 'text', job?.name || '');
    const [scheduleWrap, schedule] = field('排程', 'text', typeof job?.schedule === 'string' ? job.schedule : job?.schedule?.expr || '');
    const [promptWrap, prompt] = field('工作內容', 'textarea', job?.prompt || '');
    const panel = card([text('h2', job ? '編輯定時任務' : '新增定時任務'), nameWrap, scheduleWrap, promptWrap,
      row([button('返回', render, 'quiet-button small'), button('儲存', async () => {
        await loadSafe(async () => {
          const id = job?.id || job?.job_id;
          if (job) await api(`/cron/jobs/${encodeURIComponent(id)}`, { method: 'PUT', body: {
            updates: { name: name.value.trim(), schedule: schedule.value.trim(), prompt: prompt.value.trim() } } });
          else await api('/cron/jobs', { method: 'POST', body: { name: name.value.trim(),
            schedule: schedule.value.trim(), prompt: prompt.value.trim(), deliver: 'local', profile: state.profile } });
          await refreshTasks(); notice('已查回定時任務。');
        });
      }, 'button')])]);
    clear(); main.append(panel);
  }
  async function cronAction(id, action) {
    await loadSafe(async () => {
      await api(`/cron/jobs/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} });
      await refreshTasks(); notice(action === 'trigger' ? '已請伺服器執行；結果請查看任務記錄。' : '已查回任務狀態。');
    });
  }
  async function deleteCron(id) {
    if (!confirm('確定刪除這項定時任務？')) return;
    await loadSafe(async () => { await api(`/cron/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await refreshTasks(); notice('已刪除並重新讀取任務列表。'); });
  }
  async function refreshFiles(path = state.filePath) {
    await loadSafe(async () => {
      const profile = state.profile;
      const body = await api(`/files${path ? `?path=${encodeURIComponent(path)}` : ''}`);
      if (state.profile !== profile) return;
      state.files = body; state.filePath = body.path || path || '';
      if (state.tab === 'files') render();
    });
  }
  function renderFiles() {
    main.append(heading('文件', state.profile, [button('⋯', () => refreshFiles(), 'text-button')]));
    const listing = state.files;
    if (!listing) { main.append(text('p', '正在讀取工作區。', 'empty')); return; }
    main.append(el('div', { class: 'file-path-row' }, [
      button('‹', () => refreshFiles(listing.parent), 'quiet-button small', !listing.parent),
      text('span', listing.path || '工作區', 'path'),
      button('上傳', () => $('#workspace-upload').click(), 'text-button')]));
    const upload = el('input', { id: 'workspace-upload', type: 'file', hidden: '', on: { change: async event => {
      const file = event.target.files?.[0]; if (file) await uploadWorkspace(file);
    } } }); main.append(upload);
    if (state.document) return renderDocument();
    const entries = dataArray(listing, 'entries');
    if (!entries.length) main.append(text('p', '這裡沒有可顯示的檔案。', 'empty'));
    else {
      const folders = entries.filter(entry => entry.is_directory);
      const files = entries.filter(entry => !entry.is_directory);
      if (folders.length) {
        main.append(text('h2', '資料夾', 'group-label'));
        const grid = el('div', { class: 'folder-grid' });
        for (const entry of folders) grid.append(el('button', { type: 'button', class: 'folder-tile',
          on: { click: () => refreshFiles(entry.path) } }, [appIcon('files'), text('strong', entry.name || entry.path)]));
        main.append(grid);
      }
      if (files.length) {
        main.append(text('h2', '檔案', 'group-label'));
        const list = el('div', { class: 'file-list' });
        for (const entry of files) list.append(el('button', { class: 'list-item', type: 'button',
          on: { click: () => openFile(entry) } }, [
          el('span', { class: 'file-well' }, [el('img', { src: '/mobile/file.svg', alt: '' })]),
          el('span', { class: 'grow' }, [text('strong', entry.name || entry.path),
            text('small', `${entry.mime_type || '檔案'} · ${entry.size ?? 0} bytes`)]) ]));
        main.append(list);
      }
    }
  }
  async function uploadWorkspace(file) {
    await loadSafe(async () => {
      if (!state.filePath || file.size > 16 * 1024 * 1024) throw new Error('工作區或檔案大小不合適（上限 16 MiB）。');
      const path = `${state.filePath.replace(/\/$/, '')}/${file.name.replace(/[^\p{L}\p{N}._-]/gu, '_')}`;
      await api('/files/upload', { method: 'POST', body: { path,
        data_url: await fileToDataURL(file), overwrite: false, profile: state.profile } });
      await refreshFiles(); notice('檔案已上傳並重新讀取目錄。');
    });
  }
  async function openFile(entry) {
    await loadSafe(async () => {
      const profile = state.profile;
      const body = await api(`/files/read?path=${encodeURIComponent(entry.path)}`);
      if (state.profile !== profile) return;
      if (!body.data_url?.startsWith('data:')) throw new Error('伺服器沒有返回檔案內容');
      state.document = { ...entry, ...body }; render();
    });
  }
  function decodeDataURL(url) {
    const encoded = url.split(',')[1]; if (!encoded) throw new Error('檔案內容格式不正確');
    const binary = atob(encoded); const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return bytes;
  }
  function equalBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
    return true;
  }
  function renderDocument() {
    const doc = state.document; if (!doc) return;
    const bytes = decodeDataURL(doc.data_url);
    const mime = doc.mime_type || doc.data_url.slice(5).split(';')[0] || 'application/octet-stream';
    const editable = /^text\//.test(mime) || /\.(md|txt|json|csv)$/i.test(doc.path || '');
    const pdf = isPdfBytes(bytes);
    const blob = new Blob([bytes], { type: mime });
    const panel = card([text('h2', doc.name || doc.path), text('p', doc.path, 'path')]);
    let editor;
    if (editable) {
      let content; try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { content = '無法以 UTF-8 讀取'; }
      editor = el('textarea', { value: content, rows: '16', 'aria-label': '檔案內容' });
      panel.append(el('div', { class: 'field' }, [editor]));
      if (/\.(md|markdown)$/i.test(doc.path || '')) {
        const preview = el('div', { class: 'document' }, [markdownNode(editor.value)]);
        preview.hidden = true; panel.append(preview);
        panel.append(button('編輯／預覽', () => {
          if (preview.hidden) { preview.replaceChildren(markdownNode(editor.value)); preview.hidden = false; editor.hidden = true; }
          else { preview.hidden = true; editor.hidden = false; }
        }, 'quiet-button small'));
      }
    } else if (mime.startsWith('image/')) {
      const image = el('img', { alt: doc.name || '圖片' }); image.style.maxWidth = '100%';
      image.src = URL.createObjectURL(blob); image.addEventListener('load', () => URL.revokeObjectURL(image.src), { once: true }); panel.append(image);
    } else if (pdf) {
      activePdfURL = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      panel.append(text('p', '可在這裡預覽 PDF。若畫面空白，請使用系統預覽、新分頁或下載。'),
        el('iframe', { class: 'pdf-preview', src: activePdfURL, title: `${doc.name || '文件'} PDF 預覽`,
          referrerpolicy: 'no-referrer' }));
    } else panel.append(text('p', '這個格式請下載後查看；目前不在頁面中執行檔案內容。'));
    panel.append(row([button('返回', () => { state.document = null; render(); }, 'quiet-button small'),
      ...(pdf && window.HermesNative?.postMessage ? [button('系統預覽 PDF', () => loadSafe(async () => {
        const encoded = doc.data_url.split(',')[1];
        await nativeCall('previewPDF', { name: doc.name || 'document.pdf',
          dataURL: `data:application/pdf;base64,${encoded}` });
      }), 'soft-button small')] : []),
      ...(pdf ? [button('新分頁開啟', () => {
        const href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        const link = el('a', { href, target: '_blank', rel: 'noopener noreferrer' });
        link.click();
        setTimeout(() => URL.revokeObjectURL(href), 60000);
      }, 'quiet-button small')] : []),
      button('下載', () => { const href = URL.createObjectURL(blob); const link = el('a', { href,
        download: doc.name || 'document' }); link.click(); setTimeout(() => URL.revokeObjectURL(href), 30000); }, 'soft-button small'),
      button('分享', () => loadSafe(async () => {
        const file = new File([bytes], doc.name || 'document', { type: mime });
        if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: doc.name || '檔案' });
        else if (window.HermesNative?.postMessage && editable)
          await nativeCall('shareText', { text: new TextDecoder().decode(bytes) });
        else throw new Error('這台裝置無法直接分享此檔案；請先下載。');
      }), 'quiet-button small'),
      button('儲存', async () => {
        await loadSafe(async () => {
          const payload = new TextEncoder().encode(editor.value);
          const base64 = btoa(Array.from(payload, b => String.fromCharCode(b)).join(''));
          await api('/files/upload', { method: 'POST', body: { path: doc.path,
            data_url: `data:${mime};charset=utf-8;base64,${base64}`, overwrite: true, profile: state.profile } });
          await openFile({ path: doc.path, name: doc.name }); notice('已儲存並從伺服器讀回。');
        });
      }, 'button small', !editable)]));
    main.append(panel);
  }
  function renderMe() {
    if (state.mePage === 'settings') return renderServerSettings();
    if (state.mePage === 'soul' || state.mePage === 'memory') return renderProfileDocument();
    if (state.mePage === 'guide') return renderGuide();
    main.append(heading('我的', ''));
    const profiles = Array.isArray(state.me?.profiles) ? state.me.profiles : ['default'];
    const profileSelect = el('select', { 'aria-label': '選擇 Profile', on: { change: async event => {
      state.profile = event.target.value; state.selected = null; state.sessions = []; state.files = null;
      state.shareDraftIds = []; state.shareInbox = []; state.attachments = [];
      state.filePath = ''; state.document = null; state.projects = []; state.sessionProject = '';
      state.cron = []; state.today = null; state.inventory = null; state.settings = null;
      state.mePage = ''; state.pending.clear(); restoreTodayOperation();
      if (window.HermesNative?.postMessage) nativeCall('setNotificationProfile', { profile: state.profile }).catch(() => {});
      render(); await refreshHome(); await loadShareInbox().catch(showError);
    } } });
    for (const profile of profiles) profileSelect.append(el('option', { value: profile,
      text: profile, selected: profile === state.profile ? '' : null }));
    main.append(el('div', { class: 'profile-intro' }, [avatarVisual('profile-avatar'),
      el('div', {}, [text('h2', state.nickname || '朋友'), text('p', '個人工作助理')])]));
    main.append(card([text('h2', '我的伺服器'),
      el('div', { class: 'field' }, [text('label', 'Profile'), profileSelect]),
      text('p', `連線狀態：${state.connection}`), row([
        button('重新連線', () => { connectSocket(); notice('正在重新連線。'); }, 'soft-button small'),
        button('登出', logout, 'danger-button small'),
      ])]));
    main.append(el('div', { class: 'profile-links' }, [
      el('button', { class: 'profile-link', type: 'button', on: { click: () => openProfileDocument('memory') } },
        [appIcon('history'), el('span', { class: 'grow' }, [text('strong', '我的記憶'), text('small', '長期事實、偏好與經驗')]), text('span', '›')]),
      el('button', { class: 'profile-link', type: 'button', on: { click: () => openProfileDocument('soul') } },
        [appIcon('home'), el('span', { class: 'grow' }, [text('strong', '我的心智'), text('small', '人格、原則與行為邊界')]), text('span', '›')]) ]));
    main.append(el('div', { class: 'profile-links' }, [
      el('button', { class: 'profile-link', type: 'button', on: { click: openSettings } },
        [appIcon('settings'), el('span', { class: 'grow' }, [text('strong', '設定'), text('small', '外觀、語音、通知與權限')]), text('span', '›')]) ]));
    main.append(el('div', { class: 'profile-links' }, [
      el('button', { class: 'profile-link', type: 'button', on: { click: () => { state.mePage = 'guide'; render(); } } },
        [appIcon('files'), el('span', { class: 'grow' }, [text('strong', '使用說明'), text('small', '連接、對話、任務、語音與排查')]), text('span', '›')]) ]));
    main.append(text('div', '已連接的能力', 'subhead'));
    const inventory = state.inventory;
    if (!inventory) main.append(card([text('p', '可查看技能、工具與連接服務的名稱和狀態。'),
      button('載入清單', refreshInventory, 'soft-button small')]));
    else for (const [key, label, arrayKey] of [['skills', '技能', 'skills'], ['toolsets', '工具組', 'toolsets'], ['mcp', '連接服務', 'servers']]) {
      const body = inventory[key]; const items = dataArray(body, arrayKey, 'items', 'data');
      main.append(card([text('h2', label), ...(items.length ? items.slice(0, 80).map(item =>
        el('div', { class: 'list-item' }, [el('span', { class: 'grow' }, [
          text('strong', item.label || item.name || item.id || '未命名'),
          text('small', item.description || item.status || item.state || ''),
        ]), text('span', item.enabled === false || item.active === false ? '已停用' : '可用', 'pill'),
        ...(item.name ? [button(item.enabled === false || item.active === false ? '啟用' : '停用',
          () => toggleInventory(key, item), 'quiet-button small')] : []),
        ...(key === 'skills' && item.name ? [button('內容', () => showSkillContent(item.name), 'quiet-button small')] : [])])) :
        [text('p', body?.error || '目前沒有可顯示的項目。')]) ]));
    }
    main.append(text('div', '外觀', 'subhead'));
    const [nickWrap, nick] = field('本機稱呼', 'text', state.nickname, '朋友');
    main.append(card([el('div', { class: 'profile-photo-row' }, [avatarVisual('profile-avatar'),
      el('div', {}, [text('strong', state.nickname || '朋友'), text('small', `Profile：${state.profile}`)])]), nickWrap,
      row([button('儲存稱呼', () => loadSafe(async () => {
        const name = nick.value.trim().slice(0, 30);
        localStorage.setItem('hermes-web:nickname', name); state.nickname = name; render();
      }), 'soft-button small'), button('選照片並裁切', pickAvatarPhoto, 'quiet-button small'),
        ...(state.avatarPhoto ? [button('恢復原版頭像', () => loadSafe(async () => {
          localStorage.removeItem('hermes-web:avatar-photo'); state.avatarPhoto = ''; updateBrandAvatar(); render();
        }), 'quiet-button small')] : [])]),
      text('p', '照片裁切成 256×256 後只存在此裝置；不會更改 Gateway 帳號或 Agent 身分。'),
      row([button('跟隨系統', () => setTheme('system'), 'quiet-button small'),
        button('淺色', () => setTheme('light'), 'quiet-button small'),
        button('深色', () => setTheme('dark'), 'quiet-button small')]),
      row(['clean', 'glass', 'paper'].map(skin => button(({ clean: '清爽', glass: '液態玻璃', paper: '紙本' })[skin],
        () => setSkin(skin), skin === state.skin ? 'soft-button small' : 'quiet-button small')))]));
    main.append(card([text('h2', '版本'), text('p', 'Hermes Web · 以 Hermes Android 4.0.1 操作契約為基準。'),
      text('p', '實際 Gateway 與 iOS 功能以目前連線及裝置支援為準。')]));
  }
  async function openSettings() {
    await loadSafe(async () => { const profile = state.profile; const body = await api('/settings');
      if (profile !== state.profile) return; state.settings = body; state.mePage = 'settings';
      try { state.models = await loadModels(); } catch { /* settings remain readable */ }
      render(); });
  }
  function settingForm(title, section, specification, source) {
    const fields = {};
    const panel = card([text('h2', title)]);
    for (const [key, label, kind] of specification) {
      const current = source?.[key];
      let control;
      if (kind === 'boolean') control = el('input', { type: 'checkbox' });
      else if (kind === 'reasoning') {
        const value = reasoningValue(current);
        control = el('select', { 'aria-label': label });
        if (!value) control.append(el('option', { value: '', text: '預設', selected: '', disabled: '' }));
        for (const effort of REASONING_LEVELS) control.append(el('option', { value: effort,
          text: REASONING_LABELS[effort], selected: value === effort ? '' : null }));
      }
      else control = el('input', { type: kind === 'number' ? 'number' : 'text', value: current ?? '' });
      if (kind === 'boolean') control.checked = Boolean(current);
      fields[key] = [control, kind];
      panel.append(el('div', { class: 'field' }, [text('label', label), control]));
    }
    panel.append(button('儲存並查回', () => loadSafe(async () => {
      const changes = {};
      for (const [key, [input, kind]] of Object.entries(fields)) {
        const original = kind === 'reasoning' ? reasoningValue(source?.[key]) : source?.[key];
        const raw = kind === 'boolean' ? input.checked : input.value.trim();
        if ((kind === 'boolean' && raw === Boolean(original)) ||
            (kind !== 'boolean' && raw === String(original ?? ''))) continue;
        if (kind === 'number' && (raw === '' || !Number.isFinite(Number(raw)))) throw new Error(`${key} 需要有效數字`);
        const value = kind === 'number' ? Number(raw) : raw;
        changes[key] = value;
      }
      if (!Object.keys(changes).length) return notice('設定沒有變更。');
      const patch = section === 'timezone' ? { timezone: changes.value } : { [section]: changes };
      await saveSettingsPatch(patch);
    }), 'button small'));
    return panel;
  }
  function renderServerSettings() {
    const settings = state.settings?.settings;
    main.append(heading('對話與語音設定', `Profile：${state.profile}`, [button('返回', () => { state.mePage = ''; render(); }, 'quiet-button small')]));
    if (!settings) { main.append(button('重新讀取', openSettings, 'soft-button')); return; }
    main.append(renderModelSettings(settings));
    main.append(settingForm('對話風格', 'agent', [['personality', '對話風格', 'text'],
      ['reasoning_effort', '預設思考程度', 'reasoning']], settings.agent));
    main.append(settingForm('時區', 'timezone', [['value', '時區（例如 Asia/Taipei）', 'text']], { value: settings.timezone }));
    main.append(settingForm('顯示', 'display', [['show_reasoning', '顯示思考內容', 'boolean']], settings.display));
    main.append(settingForm('操作批准', 'approvals', [['mode', '模式', 'text'], ['timeout', '等待秒數', 'number']], settings.approvals));
    main.append(settingForm('記憶', 'memory', [['memory_enabled', '啟用記憶', 'boolean'],
      ['user_profile_enabled', '啟用個人資料', 'boolean'], ['memory_char_limit', '記憶字數上限', 'number'],
      ['user_char_limit', '個人資料字數上限', 'number']], settings.memory));
    main.append(settingForm('對話整理', 'compression', [['enabled', '啟用整理', 'boolean'],
      ['threshold', '開始比例', 'number'], ['target_ratio', '目標比例', 'number'],
      ['protect_last_n', '保留最近訊息數', 'number']], settings.compression));
    main.append(settingForm('伺服器聽寫', 'stt', [['enabled', '啟用', 'boolean'], ['provider', '服務', 'text'],
      ['model', '模型', 'text'], ['language', '語言', 'text']], settings.stt));
    main.append(settingForm('伺服器朗讀', 'tts', [['provider', '服務', 'text'], ['model', '模型', 'text'],
      ['voice', '聲音', 'text']], settings.tts));
    main.append(card([text('h2', '本機語音與通知'),
      text('p', '朗讀與聽寫先使用這台裝置的能力；伺服器語音設定另存於上方。'),
      text('p', 'iOS 背景查詢由系統決定，提醒可能延遲；不是即時推播。'),
      ...[['stt', '聽寫方式'], ['tts', '朗讀方式']].map(([kind, label]) => {
        const select = el('select', { 'aria-label': label, on: { change: () => {
          state[`${kind}Mode`] = select.value; localStorage.setItem(`hermes-web:${kind}Mode`, select.value);
        } } });
        for (const [value, option] of [['device', '裝置'], ['server', '伺服器']]) select.append(el('option',
          { value, text: option, selected: state[`${kind}Mode`] === value ? '' : null }));
        return el('div', { class: 'field' }, [text('label', label), select]);
      }),
      row([button('試聽', () => speakText('嗨，我是澪。'), 'soft-button small'),
        button('停止朗讀', () => { if (window.HermesNative?.postMessage) loadSafe(() => nativeCall('stopSpeaking'));
          state.speechAudio?.pause(); state.speechAudio = null; window.speechSynthesis?.cancel(); }, 'quiet-button small'),
        button('允許通知', () => loadSafe(async () => {
          let granted;
          if (window.HermesNative?.postMessage) granted = (await nativeCall('requestNotificationPermission')).granted === true;
          else if ('Notification' in window) granted = (await Notification.requestPermission()) === 'granted';
          else throw new Error('此裝置不支援通知。');
          notice(granted ? '通知權限已允許；實際送達仍需驗證。' : '通知權限未允許；可到裝置設定調整。');
        }), 'quiet-button small')])]));
  }
  function renderModelSettings(settings) {
    const panel = card([text('h2', '模型設定'), text('p', '這會影響新的伺服器對話；單一會話的模型可在對話內切換。')]);
    const model = settings.model || {};
    const provider = el('select', { 'aria-label': '主要服務' });
    const catalog = dataArray(state.models, 'providers').filter(row => row.authenticated !== false);
    for (const row of catalog) provider.append(el('option', { value: row.slug, text: row.name || row.slug,
      selected: row.slug === model.provider ? '' : null }));
    if (!catalog.some(row => row.slug === model.provider) && model.provider)
      provider.prepend(el('option', { value: model.provider, text: `${model.provider}（目前設定）` }));
    const choice = el('select', { 'aria-label': '主要模型' });
    function drawModels() {
      choice.replaceChildren(); const row = catalog.find(item => item.slug === provider.value);
      const models = row?.models || [];
      for (const name of models) choice.append(el('option', { value: name, text: name,
        selected: name === model.default ? '' : null }));
      if (provider.value === model.provider && !models.includes(model.default) && model.default) choice.prepend(el('option',
        { value: model.default, text: `${model.default}（目前設定）` }));
    }
    provider.addEventListener('change', drawModels); drawModels();
    const [contextWrap, context] = field('上下文長度（0 表示預設）', 'number', model.context_length || 0);
    panel.append(el('div', { class: 'field' }, [text('label', '主要服務'), provider]),
      el('div', { class: 'field' }, [text('label', '主要模型'), choice]), contextWrap);
    panel.append(button('儲存主要模型', () => saveSettingsPatch({ model: { provider: provider.value,
      default: choice.value, context_length: Number(context.value) } }), 'button small'));
    const aux = settings.auxiliary || {};
    const auxInputs = new Map();
    for (const [key, label] of [['vision', '影像'], ['web_extract', '網頁擷取'], ['compression', '對話整理'],
      ['skills_hub', '技能中心'], ['approval', '批准'], ['mcp', '連接服務'],
      ['title_generation', '標題'], ['curator', '策展']]) {
      const [wrap, fieldInput] = field(label, 'text', `${aux[key]?.provider || 'auto'}/${aux[key]?.model || ''}`);
      auxInputs.set(key, fieldInput); panel.append(wrap);
    }
    panel.append(button('儲存輔助模型', () => loadSafe(async () => {
      const patch = {};
      for (const [key, input] of auxInputs) {
        const textValue = input.value.trim(); const slash = textValue.indexOf('/');
        if (slash < 1) throw new Error(`${key} 請用 provider/model 格式；auto/ 可保留預設。`);
        patch[key] = { provider: textValue.slice(0, slash), model: textValue.slice(slash + 1) };
      }
      await saveSettingsPatch({ auxiliary: patch });
    }), 'soft-button small'));
    const fallback = el('textarea', { rows: '4', 'aria-label': '備援模型' });
    fallback.value = (settings.fallback_providers || []).map(row => `${row.provider}/${row.model}`).join('\n');
    panel.append(el('div', { class: 'field' }, [text('label', '備援模型（每行 provider/model）'), fallback]));
    panel.append(button('儲存備援', () => loadSafe(async () =>
      saveSettingsPatch({ fallback_providers: parseProviderModelLines(fallback.value) })), 'soft-button small'));
    const refs = el('textarea', { rows: '4', 'aria-label': '參考模型' });
    refs.value = (settings.moa?.reference_models || []).join('\n');
    const [aggregatorWrap, aggregator] = field('彙整模型', 'text', settings.moa?.aggregator_model || '');
    panel.append(el('div', { class: 'field' }, [text('label', 'MoA 參考模型（每行 provider:model）'), refs]), aggregatorWrap,
      button('儲存 MoA', () => loadSafe(async () => saveSettingsPatch({ moa: {
        reference_models: parseMoASpecLines(refs.value),
        aggregator_model: aggregator.value.trim() } })), 'soft-button small'));
    return panel;
  }
  async function saveSettingsPatch(patch) {
    await loadSafe(async () => {
      if (!state.settings?.revision) throw new Error('請先重新讀取設定。');
      await api('/settings', { method: 'PUT', body: { revision: state.settings.revision, settings: patch } });
      const readback = await api('/settings');
      if (readback.profile !== state.profile) throw new Error('設定的 Profile 不一致');
      if (!patchMatches(readback.settings, patch)) throw new Error('伺服器尚未回傳相同設定，請重新核對。');
      state.settings = readback; render(); notice('已儲存並重新讀取伺服器設定。');
    });
  }
  async function openProfileDocument(kind) {
    await loadSafe(async () => { const profile = state.profile; const body = await api(`/profile-documents/${kind}`);
      if (profile !== state.profile) return; state.profileDoc = body; state.mePage = kind; render(); });
  }
  function renderProfileDocument() {
    const kind = state.mePage; const body = state.profileDoc;
    main.append(heading(kind === 'soul' ? 'SOUL' : 'MEMORY', `Profile：${state.profile}`,
      [button('返回', () => { state.mePage = ''; render(); }, 'quiet-button small')]));
    if (body?.kind !== kind || body.profile !== state.profile) return;
    const [wrap, input] = field('內容', 'textarea', body.content || ''); input.rows = 20;
    main.append(card([text('p', body.exists ? '儲存時會檢查你讀取後有沒有被其他裝置修改。' : '此 Profile 尚無文件；儲存會建立文件。'),
      wrap, button('儲存並查回', () => loadSafe(async () => {
        const content = input.value;
        await api(`/profile-documents/${kind}`, { method: 'PUT', body: { content, revision: body.revision } });
        const check = await api(`/profile-documents/${kind}`);
        if (check.profile !== state.profile || check.content !== content) throw new Error('文件尚未查回一致版本');
        state.profileDoc = check; render(); notice('文件已儲存並查回。');
      }), 'button')]));
  }
  function renderGuide() {
    main.append(heading('三步開始', '可以隨時回來重看。',
      [button('返回', () => { state.mePage = ''; render(); }, 'quiet-button small')]));
    for (const [title, description] of [['1. 準備 Hermes', '伺服器上的模型、工具和記憶仍在原本的 Hermes。'],
      ['2. 連線', '使用 Gateway 帳號登入此行動入口；不需在網頁保存密碼。'],
      ['3. 開始使用', '先用簡潔首頁聊天；需要事項卡時再開啟深度首頁。']])
      main.append(card([text('h2', title), text('p', description)]));
  }
  async function refreshInventory() {
    const profile = state.profile;
    const entries = await Promise.allSettled(['skills', 'toolsets', 'mcp'].map(path => api(`/${path}`)));
    if (state.profile !== profile) return;
    state.inventory = Object.fromEntries(['skills', 'toolsets', 'mcp'].map((key, index) =>
      [key, entries[index].status === 'fulfilled' ? entries[index].value : { error: '暫時無法讀取。' }]));
    if (state.tab === 'me') render();
  }
  async function toggleInventory(kind, item) {
    await loadSafe(async () => {
      const enabled = item.enabled === false || item.active === false;
      await api(`/inventory/${kind}/enabled`, { method: 'PUT', body: { name: item.name, enabled } });
      await refreshInventory();
      const changed = dataArray(state.inventory?.[kind], kind === 'mcp' ? 'servers' : kind, 'items', 'data')
        .find(row => row.name === item.name);
      if (!changed || (changed.enabled !== undefined && changed.enabled !== enabled))
        throw new Error('能力狀態尚未讀回一致，請重新核對。');
      notice('已從伺服器查回能力狀態。');
    });
  }
  async function showSkillContent(name) {
    await loadSafe(async () => {
      const body = await api(`/inventory/skills/content?name=${encodeURIComponent(name)}`);
      clear(); main.append(card([text('h2', name), el('div', { class: 'document' }, [markdownNode(body.content || body.text || '')]),
        button('返回', render, 'quiet-button small')]));
    });
  }
  function setTheme(theme) {
    if (theme === 'system') { delete document.documentElement.dataset.theme; localStorage.removeItem('hermes-web:theme'); }
    else { document.documentElement.dataset.theme = theme; localStorage.setItem('hermes-web:theme', theme); }
  }
  function setSkin(skin) { state.skin = skin; document.documentElement.dataset.skin = skin;
    localStorage.setItem('hermes-web:skin', skin); render(); }
  async function logout() {
    await loadSafe(async () => {
      await authRequest('logout', { method: 'POST' });
      state.ws?.close(); state.ws = null; state.wsReady = false;
      state.me = null; state.csrf = ''; state.selected = null; state.messages = [];
      state.requestDrafts.clear(); state.turnAttempts.clear(); state.protocolReady = false;
      state.capabilityPromise = null; state.reasoning = ''; state.streamStarted = false; state.streamed = '';
      state.run = 'idle'; state.sendAttempted = false;
      state.sessions = []; state.cron = []; state.files = null; state.pending.clear();
      state.shareInbox = []; state.shareDraftIds = []; state.attachments = [];
      for (let index = sessionStorage.length - 1; index >= 0; index--) {
        const key = sessionStorage.key(index); if (key?.startsWith('hermes-web:draft:')) sessionStorage.removeItem(key);
      }
      render();
    });
  }
  function init() {
    state.nickname = (localStorage.getItem('hermes-web:nickname') || '').slice(0, 30);
    const savedPhoto = localStorage.getItem('hermes-web:avatar-photo') || '';
    state.avatarPhoto = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(savedPhoto) && savedPhoto.length <= 350000 ? savedPhoto : '';
    const previousSkin = localStorage.getItem('hermes-web:skin');
    state.skin = ['clean', 'glass', 'paper'].includes(previousSkin) ? previousSkin : 'glass';
    if (previousSkin !== state.skin) localStorage.setItem('hermes-web:skin', state.skin);
    state.sttMode = localStorage.getItem('hermes-web:sttMode') === 'server' ? 'server' : 'device';
    state.ttsMode = localStorage.getItem('hermes-web:ttsMode') === 'server' ? 'server' : 'device';
    document.documentElement.dataset.skin = state.skin;
    updateBrandAvatar();
    const savedTheme = localStorage.getItem('hermes-web:theme');
    if (savedTheme === 'light' || savedTheme === 'dark') setTheme(savedTheme);
    $('#theme-button').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
    window.addEventListener('online', connectSocket);
    window.addEventListener('offline', () => setConnection('離線'));
    window.addEventListener('hermes-share-incoming', event => acceptIncomingShare(event.detail));
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/mobile/sw.js', { scope: '/mobile/' }).catch(() => {});
    authRequest('me').then(me => {
      if (me.authenticated) bootstrap().catch(showError);
      else { state.me = null; render(); }
    }).catch(() => { state.me = null; render(); });
  }
  init();
})();
