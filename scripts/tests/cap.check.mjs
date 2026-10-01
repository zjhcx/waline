import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, test } from 'node:test';
import { useCap } from '../../packages/client/src/composables/cap.ts';
import { useCap as useAdminCap } from '../../packages/admin/src/components/useCap.js';

const require = createRequire(import.meta.url);
const verifyCap = require('../../packages/server/src/service/cap.js');
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete globalThis.window;
  delete globalThis.document;
});
const config = { endpoint: 'https://cap.example/site///', secret: 'secret', token: 'token' };

test('Cap sends JSON to the site endpoint and accepts only success=true', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://cap.example/site/siteverify');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { secret: 'secret', response: 'token' });
    return Response.json({ success: true });
  };
  assert.equal(await verifyCap(config), true);
});

test('missing tokens and incomplete configuration are rejected without fetching', async () => {
  globalThis.fetch = () => {
    throw new Error('must not fetch');
  };
  for (const bad of [{ token: '' }, { token: 1 }, { secret: '' }, { endpoint: '' }]) {
    assert.equal(await verifyCap({ ...config, ...bad }), false);
  }

});

test('invalid responses, HTTP errors and network errors fail closed on the server', async () => {
  const responses = [
    () => Response.json({ success: false }),
    () => Response.json({ success: 'true' }),
    () => Response.json({ success: true }, { status: 500 }),
    () => new Response('invalid json'),
    () => {
      throw new Error('offline');
    },
  ];
  for (const respond of responses) {
    globalThis.fetch = async () => respond();
    assert.equal(await verifyCap(config), false);

  }
});

test('client and admin solve fresh challenges and reset each instance', async () => {
  let solved = 0;
  let reset = 0;
  globalThis.window = {
    capApiEndpoint: config.endpoint,
    Cap: class {
      widget = { remove() {} };
      constructor(options) {
        assert.equal(options.apiEndpoint, 'https://cap.example/site/');
      }
      async solve() {
        return { token: `token-${++solved}` };
      }
      reset() {
        reset++;
      }
    },
  };
  const client = useCap(config.endpoint);
  assert.equal(await client.execute(), 'token-1');
  assert.equal(await client.execute(), 'token-2');
  assert.equal(await useAdminCap()(), 'token-3');
  assert.equal(reset, 3);
});

test('widget loading failures reject and allow retry', async () => {
  globalThis.window = {};
  let calls = 0;
  globalThis.document = {
    createElement: () => ({ remove() {} }),
    head: {
      append(script) {
        calls++;
        queueMicrotask(() => script.onerror());
      },
    },
  };
  const client = useCap(config.endpoint, 'https://example.com/broken.js');
  await assert.rejects(client.execute(), /could not be loaded/);
  await assert.rejects(client.execute(), /could not be loaded/);
  assert.equal(calls, 2);
});
