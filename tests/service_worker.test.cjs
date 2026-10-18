const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function worker() {
  const handlers = {}, fetched = [];
  const cachedURL = 'https://fixture.invalid/mobile/styles.css?v=old';
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/sw.js'), 'utf8'), {
    URL,
    self: { location: { origin: 'https://fixture.invalid' }, addEventListener: (name, handler) => { handlers[name] = handler; } },
    caches: { match: async (request, options) =>
      (request.url === cachedURL || options?.ignoreSearch) ? 'cached-old' : undefined },
    fetch: async request => { fetched.push(request.url); return 'network-new'; },
  });
  const request = async url => {
    let response;
    handlers.fetch({ request: { url, method: 'GET', mode: 'cors' }, respondWith: value => { response = value; } });
    return response;
  };
  return { request, fetched, cachedURL };
}

test('a new asset version never receives the old cached stylesheet', async () => {
  const w = worker();
  assert.equal(await w.request('https://fixture.invalid/mobile/styles.css?v=new'), 'network-new');
  assert.equal(w.fetched.length, 1);
});

test('the exact cached version remains available without a network request', async () => {
  const w = worker();
  assert.equal(await w.request(w.cachedURL), 'cached-old');
  assert.equal(w.fetched.length, 0);
});

test('API and external requests bypass the static cache', async () => {
  const w = worker();
  assert.equal(await w.request('https://fixture.invalid/mobile/api/me'), undefined);
  assert.equal(await w.request('https://other.invalid/mobile/styles.css'), undefined);
  assert.equal(w.fetched.length, 0);
});
