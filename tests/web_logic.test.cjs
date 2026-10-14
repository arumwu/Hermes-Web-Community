const test = require('node:test');
const assert = require('node:assert/strict');
const { scopedSessionKey, legacyRequestParams, canSubmitTurn, isPdfBytes, squareCropGeometry, persistAvatarPhoto, safeLink,
  parseProviderModelLines, parseMoASpecLines, confirmedTodayReceipt, patchMatches, shareStorageKey,
  reasoningChoices, selectionFromInfo, reasoningValue } = require('../web/app.js');

test('native model capability payload exposes reasoning without an invented reasoning_options field', () => {
  const catalog = { providers: [{ slug: 'openai-codex', capabilities: {
    'gpt-6.1-sol': { reasoning: true }, plain: { reasoning: false }, mandatory: { reasoning: true, can_disable_reasoning: false } } }] };
  assert.deepEqual(reasoningChoices(catalog, { provider: 'openai-codex', model: 'gpt-6.1-sol' }),
    ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(reasoningChoices(catalog, { provider: 'openai-codex', model: 'plain' }), []);
  assert.equal(reasoningChoices(catalog, { provider: 'openai-codex', model: 'mandatory' }).includes('none'), false);
  assert.deepEqual(reasoningChoices(catalog, { provider: 'unavailable', model: 'gpt-6.1-sol' }), []);
});

test('fresh lazy session adopts authoritative provider and disabled reasoning after readback', () => {
  const session = { id: 'stored', runtimeId: 'live', fresh: true, model: 'old', provider: '' };
  const updated = selectionFromInfo(session, { session_id: 'live', info: {
    model: 'gpt-6.1-sol', provider: 'openai-codex', reasoning_effort: 'high' } }, 'none');
  assert.equal(updated.provider, 'openai-codex'); assert.equal(updated.model, 'gpt-6.1-sol');
  assert.equal(updated.reasoningEffort, 'none'); assert.equal(updated.fresh, true);
  assert.equal(reasoningValue(false), 'none');
  assert.equal(reasoningValue({ enabled: true, effort: 'xhigh' }), 'xhigh');
});

test('same session id remains isolated by profile and drafts cannot alias', () => {
  assert.notEqual(scopedSessionKey({ id: 'same-id', profile: 'default' }),
    scopedSessionKey({ id: 'same-id', profile: 'secondary' }));
  assert.equal(scopedSessionKey({ id: 'same-id' }, 'secondary'), 'secondary::same-id');
  assert.throws(() => scopedSessionKey({ id: 'same-id' }, ''), /範圍/);
});

test('legacy clarify response carries runtime, request and original profile', () => {
  assert.deepEqual(legacyRequestParams({ type: 'clarify', runtimeId: 'run-9', key: 'req-3', profile: 'secondary' }, '選 A'),
    { session_id: 'run-9', request_id: 'req-3', profile: 'secondary', answer: '選 A' });
  assert.deepEqual(legacyRequestParams({ type: 'approval', runtimeId: 'run-9', key: 'req-4', profile: 'secondary' }, 'deny'),
    { session_id: 'run-9', request_id: 'req-4', profile: 'secondary', choice: 'deny' });
});

test('second or ambiguous prompt is not eligible for another submission', () => {
  const session = { id: 'stored-1', profile: 'secondary' };
  assert.equal(canSubmitTurn('idle', false, session, 'secondary'), true);
  assert.equal(canSubmitTurn('preparing', false, session, 'secondary'), false);
  assert.equal(canSubmitTurn('running', true, session, 'secondary'), false);
  assert.equal(canSubmitTurn('uncertain', true, session, 'secondary'), false);
  assert.equal(canSubmitTurn('idle', false, session, 'default'), false);
});

test('browser PDF opening requires a PDF header, not just a filename or MIME claim', () => {
  assert.equal(isPdfBytes(Buffer.from('%PDF-1.7\n')), true);
  assert.equal(isPdfBytes(Buffer.from('<script>alert(1)</script>')), false);
  assert.equal(isPdfBytes(Buffer.from('%PDF')), false);
});

test('photo crop always covers the 256 square and clamps panning', () => {
  const centered = squareCropGeometry(800, 400, 1);
  assert.deepEqual(centered, { x: -128, y: 0, drawWidth: 512, drawHeight: 256 });
  const shifted = squareCropGeometry(800, 400, 1, 999, -999);
  assert.equal(shifted.x, 0); assert.equal(shifted.y, 0);
  assert.throws(() => squareCropGeometry(10000, 10000, 1), /尺寸/);
  assert.throws(() => squareCropGeometry(800, 400, 0.5), /尺寸/);
});

test('invalid or failed photo storage leaves prior avatar intact', () => {
  let previous = 'data:image/jpeg;base64,T0xE';
  const storage = { setItem(_key, value) { if (value.includes('RkFJTA')) throw new Error('quota'); previous = value; } };
  assert.throws(() => persistAvatarPhoto(storage, 'data:image/svg+xml;base64,PHN2Zz4='), /覆寫/);
  assert.equal(previous, 'data:image/jpeg;base64,T0xE');
  assert.throws(() => persistAvatarPhoto(storage, 'data:image/jpeg;base64,RkFJTA=='), /quota/);
  assert.equal(previous, 'data:image/jpeg;base64,T0xE');
});

test('Markdown links reject script and local-file schemes', () => {
  assert.equal(safeLink('javascript:alert(1)'), null);
  assert.equal(safeLink('file:///etc/passwd'), null);
  assert.equal(safeLink('https://example.org/a'), 'https://example.org/a');
});

test('model fallback lines have bounded provider/model structure', () => {
  assert.deepEqual(parseProviderModelLines('openai/gpt-6.1-sol\n anthropic/claude-sonnet-4.5 '),
    [{ provider: 'openai', model: 'gpt-6.1-sol' }, { provider: 'anthropic', model: 'claude-sonnet-4.5' }]);
  assert.throws(() => parseProviderModelLines('javascript:alert(1)'), /格式/);
});

test('MoA uses the server provider:model wire format', () => {
  assert.deepEqual(parseMoASpecLines('openai:gpt-6.1-sol\nopenrouter:foo/bar'),
    ['openai:gpt-6.1-sol', 'openrouter:foo/bar']);
  assert.throws(() => parseMoASpecLines('openai/gpt-6.1-sol'), /provider:model/);
});

test('durable share keys isolate owner and profile', () => {
  const a = 'a'.repeat(64), b = 'b'.repeat(64);
  assert.notEqual(shareStorageKey(a, 'secondary', 'id-1'), shareStorageKey(a, 'default', 'id-1'));
  assert.notEqual(shareStorageKey(a, 'secondary', 'id-1'), shareStorageKey(b, 'secondary', 'id-1'));
  assert.throws(() => shareStorageKey('raw-owner', 'secondary', 'id-1'), /範圍/);
});

test('Today completion requires the exact operation receipt, not a finished chat', () => {
  const operation = { operation_id: 'op-1', mode: 'apply_card_action', card_id: 'card-1' };
  assert.equal(confirmedTodayReceipt({ ok: true, operation_id: 'op-1', mode: 'apply_card_action', card_id: 'card-1' }, operation), false);
  assert.equal(confirmedTodayReceipt({ confirmed: true, operation_id: 'op-2', mode: 'apply_card_action', card_id: 'card-1' }, operation), false);
  assert.equal(confirmedTodayReceipt({ confirmed: true, operation_id: 'op-1', mode: 'apply_card_action', card_id: 'card-2' }, operation), false);
  assert.equal(confirmedTodayReceipt({ confirmed: true, operation_id: 'op-1', mode: 'apply_card_action', card_id: 'card-1' }, operation), true);
});

test('settings readback must contain the saved leaves exactly', () => {
  assert.equal(patchMatches({ agent: { personality: 'warm', reasoning_effort: 'xhigh' } },
    { agent: { personality: 'warm' } }), true);
  assert.equal(patchMatches({ approvals: { timeout: 30 } }, { approvals: { timeout: 60 } }), false);
  assert.equal(patchMatches({ fallback_providers: [{ provider: 'openai', model: 'gpt' }] },
    { fallback_providers: [{ provider: 'openai', model: 'gpt' }] }), true);
});
