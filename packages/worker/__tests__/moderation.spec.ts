/* oxlint-disable vitest/max-expects, vitest/no-conditional-in-test, typescript/explicit-function-return-type, typescript/require-await */
import { describe, expect, it, vi } from 'vitest';

import type { WorkerEnv } from '../src/core.js';
import { signToken } from '../src/core.js';
import worker from '../src/index.js';

describe('worker comment moderation', () => {
  it.each([
    ['Pass', '', 'approved', 'guest'],
    ['Pass', 'true', 'waiting', 'guest'],
    ['Review', '', 'waiting', 'guest'],
    ['Block', 'true', 'spam', 'guest'],
    ['Block', '', 'spam', 'administrator'],
    ['Review', '', 'waiting', 'administrator'],
    ['Pass', 'true', 'approved', 'administrator'],
  ])('stores %s with audit=%s as %s for %s', async (suggestion, audit, status, role) => {
    let saved: Record<string, unknown> | undefined;
    const env = {
      TENCENT_SECRET_ID: 'test-id',
      TENCENT_SECRET_KEY: 'test-key',
      COMMENT_AUDIT: audit,
      JWT_TOKEN: 'test-jwt-secret',
      DB: {
        prepare: (sql: string) => ({
          bind: (...values: unknown[]) => ({
            first: async () => {
              if (sql.includes('wl_Users')) return { id: 1, type: role, email: 'test@example.com' };
              if (!sql.startsWith('INSERT')) return null;
              const columns = sql
                .slice(sql.indexOf('(') + 1, sql.indexOf(')'))
                .split(',')
                .map((column) => column.trim().replaceAll('"', ''));
              saved = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
              return { id: 1, ...saved };
            },
          }),
        }),
      },
    } as unknown as WorkerEnv;
    const request = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ Response: { Suggestion: suggestion } }));
    try {
      const response = await worker.fetch(
        new Request('https://waline.example/api/comment', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(role === 'administrator'
              ? { authorization: `Bearer ${await signToken(1, 'test-jwt-secret')}` }
              : {}),
          },
          body: JSON.stringify({ comment: 'test', url: '/', nick: 'Reader', status: 'approved' }),
        }),
        env,
        {} as Parameters<typeof worker.fetch>[2],
      );
      expect(response.status).toBe(200);
      expect(saved?.status).toBe(status);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      request.mockRestore();
    }
  });
});
