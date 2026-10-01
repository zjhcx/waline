import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, test } from 'node:test';
import { verifyCaptcha } from '../../packages/worker/src/core.ts';
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
const env = { CAP_API_ENDPOINT: config.endpoint, CAP_SECRET: config.secret };

test('Cap sends JSON to the site endpoint and accepts only success=true', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://cap.example/site/siteverify');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { secret: 'secret', response: 'token' });
    return Response.json({ success: true });
  };
  assert.equal(await verifyCap(config), true);
  await verifyCaptcha(new Request('https://waline.example'), env, undefined, 'token');
});

test('missing tokens and incomplete configuration are rejected without fetching', async () => {
  globalThis.fetch = () => {
    throw new Error('must not fetch');
  };
  for (const bad of [{ token: '' }, { token: 1 }, { secret: '' }, { endpoint: '' }]) {
    assert.equal(await verifyCap({ ...config, ...bad }), false);
  }
  await assert.rejects(verifyCaptcha(new Request('https://waline.example'), env, undefined), {
    status: 403,
  });
  await assert.rejects(
    verifyCaptcha(
      new Request('https://waline.example'),
      { CAP_SECRET: 'secret' },
      undefined,
      'token',
    ),
    { status: 403 },
  );
});

test('invalid responses, HTTP errors and network errors fail closed in both runtimes', async () => {
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
    await assert.rejects(
      verifyCaptcha(new Request('https://waline.example'), env, undefined, 'token'),
      { status: 403 },
    );
  }
});

test('Cap has priority over Turnstile; disabled CAPTCHA does not fetch', async () => {
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    assert.match(url, /cap\.example/);
    return Response.json({ success: true });
  };
  await verifyCaptcha(
    new Request('https://waline.example'),
    { ...env, TURNSTILE_SECRET: 'other' },
    'other-token',
    'token',
  );
  await verifyCaptcha(new Request('https://waline.example'), {}, undefined);
  assert.equal(calls, 1);
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
