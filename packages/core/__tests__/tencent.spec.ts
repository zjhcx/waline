/* oxlint-disable vitest/max-expects */
import { createHash, createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { moderateTencentText } from '../src/tencent.js';
import type { TencentModerationDiagnostic } from '../src/tencent.js';

const config = { TENCENT_SECRET_ID: 'test-id', TENCENT_SECRET_KEY: 'test-key' };

describe('tencent text moderation', () => {
  it('reports API failures without exposing credentials, content or API messages', async () => {
    const report = vi.fn<(event: TencentModerationDiagnostic) => void>();
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        Response: {
          RequestId: 'request-1',
          Error: { Code: 'AuthFailure.SignatureFailure', Message: 'private API details' },
        },
      }),
    );
    await expect(moderateTencentText('private comment', config, request, report)).resolves.toBe(
      'waiting',
    );
    expect(report).toHaveBeenCalledWith({
      reason: 'api',
      code: 'AuthFailure.SignatureFailure',
      requestId: 'request-1',
    });
    const output = JSON.stringify(report.mock.calls);
    expect(output).not.toContain('test-key');
    expect(output).not.toContain('test-id');
    expect(output).not.toContain('private');
  });

  it('distinguishes genuine review results from failed requests and disabled configuration', async () => {
    const report = vi.fn<(event: TencentModerationDiagnostic) => void>();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ Response: { Suggestion: 'Review', RequestId: 'r' } }))
      .mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'));
    await moderateTencentText('text', config, request, report);
    expect(report).toHaveBeenLastCalledWith({
      reason: 'result',
      suggestion: 'Review',
      requestId: 'r',
    });
    await moderateTencentText('text', config, request, report);
    expect(report).toHaveBeenLastCalledWith({ reason: 'request', code: 'TimeoutError' });
    await moderateTencentText('text', {}, request, report);
    expect(report).toHaveBeenLastCalledWith({ reason: 'disabled' });
  });

  it('signs UTF-8 content using TC3 and sends the configured policy', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ Response: { Suggestion: 'Pass' } }));
    await expect(
      moderateTencentText(
        '你好🌍',
        { ...config, TENCENT_BIZ_TYPE: 'comments', TENCENT_REGION: 'ap-shanghai' },
        request,
      ),
    ).resolves.toBe('approved');
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('https://tms.tencentcloudapi.com');
    const headers = new Headers(init?.headers);
    const body = init?.body as string;
    expect(JSON.parse(body)).toStrictEqual({
      Content: Buffer.from('你好🌍').toString('base64'),
      Type: 'TEXT',
      BizType: 'comments',
    });
    expect(headers.get('X-TC-Region')).toBe('ap-shanghai');
    expect(headers.get('X-TC-Action')).toBe('TextModeration');
    const timestamp = headers.get('X-TC-Timestamp');
    const date = new Date(Number(timestamp) * 1000).toISOString().slice(0, 10);
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:tms.tencentcloudapi.com\n\ncontent-type;host\n${hash(body)}`;
    const dateKey = createHmac('sha256', 'TC3test-key').update(date).digest();
    const serviceKey = createHmac('sha256', dateKey).update('tms').digest();
    const signingKey = createHmac('sha256', serviceKey).update('tc3_request').digest();
    const signature = createHmac('sha256', signingKey)
      .update(`TC3-HMAC-SHA256\n${timestamp}\n${date}/tms/tc3_request\n${hash(canonical)}`)
      .digest('hex');
    expect(headers.get('Authorization')).toBe(
      `TC3-HMAC-SHA256 Credential=test-id/${date}/tms/tc3_request, SignedHeaders=content-type;host, Signature=${signature}`,
    );
  });

  it.each([
    ['Pass', 'approved'],
    ['Review', 'waiting'],
    ['Block', 'spam'],
    ['unknown', 'waiting'],
  ])('maps %s to %s', async (suggestion, expected) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ Response: { Suggestion: suggestion } }));
    await expect(moderateTencentText('text', config, request)).resolves.toBe(expected);
  });

  it('does not publish on transport, API or malformed response errors', async () => {
    const request = vi.fn<typeof fetch>();
    request.mockRejectedValueOnce(new Error('timeout'));
    request.mockResolvedValueOnce(new Response('', { status: 503 }));
    request.mockResolvedValueOnce(
      Response.json({ Response: { Error: { Code: 'AuthFailure' }, Suggestion: 'Pass' } }),
    );
    request.mockResolvedValueOnce(new Response('invalid JSON'));
    request.mockResolvedValueOnce(Response.json({}));
    await expect(
      Promise.all(Array.from({ length: 5 }, () => moderateTencentText('text', config, request))),
    ).resolves.toStrictEqual(Array.from({ length: 5 }, () => 'waiting'));
  });

  it('disables unconfigured moderation and holds incomplete config or oversized text', async () => {
    const request = vi.fn<typeof fetch>();
    await expect(moderateTencentText('text', {}, request)).resolves.toBeUndefined();
    await expect(moderateTencentText('text', { TENCENT_SECRET_ID: 'id' }, request)).resolves.toBe(
      'waiting',
    );
    await expect(moderateTencentText('a'.repeat(10_001), config, request)).resolves.toBe('waiting');
    expect(request).not.toHaveBeenCalled();
  });
});
