export interface TencentModerationConfig {
  TENCENT_SECRET_ID?: string;
  TENCENT_SECRET_KEY?: string;
  TENCENT_REGION?: string;
  TENCENT_BIZ_TYPE?: string;
}

export type ModerationStatus = 'approved' | 'waiting' | 'spam';

export interface TencentModerationDiagnostic {
  reason:
    | 'disabled'
    | 'configuration'
    | 'length'
    | 'http'
    | 'api'
    | 'result'
    | 'response'
    | 'request';
  status?: number;
  code?: string;
  requestId?: string;
  suggestion?: 'Pass' | 'Review' | 'Block';
}

const encoder = new TextEncoder();
const hex = (value: ArrayBuffer) =>
  Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
const digest = async (value: string) =>
  hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
const sign = async (secret: string | ArrayBuffer, value: string) => {
  const key = await crypto.subtle.importKey(
    'raw',
    typeof secret === 'string' ? encoder.encode(secret) : secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', key, encoder.encode(value));
};

// Returns undefined when disabled; failures stay pending for manual review.
export const moderateTencentText = async (
  content: string,
  config: TencentModerationConfig,
  request: typeof fetch = globalThis.fetch,
  report: (event: TencentModerationDiagnostic) => void = () => {
    // Diagnostics are optional for callers outside the Worker.
  },
): Promise<ModerationStatus | undefined> => {
  if (!config.TENCENT_SECRET_ID && !config.TENCENT_SECRET_KEY) {
    report({ reason: 'disabled' });
    return undefined;
  }
  if (!config.TENCENT_SECRET_ID || !config.TENCENT_SECRET_KEY) {
    report({ reason: 'configuration' });
    return 'waiting';
  }
  // Tencent measures Unicode code points, not grapheme clusters.
  // oxlint-disable-next-line typescript/no-misused-spread
  if ([...content].length > 10_000) {
    report({ reason: 'length' });
    return 'waiting';
  }
  try {
    const host = 'tms.tencentcloudapi.com';
    const contentType = 'application/json; charset=utf-8';
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const scope = `${date}/tms/tc3_request`;
    const body = JSON.stringify({
      Content: btoa(
        Array.from(encoder.encode(content), (byte) => String.fromCodePoint(byte)).join(''),
      ),
      Type: 'TEXT',
      ...(config.TENCENT_BIZ_TYPE ? { BizType: config.TENCENT_BIZ_TYPE } : {}),
    });
    const canonical = `POST\n/\n\ncontent-type:${contentType}\nhost:${host}\n\ncontent-type;host\n${await digest(body)}`;
    const toSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${await digest(canonical)}`;
    const dateKey = await sign(`TC3${config.TENCENT_SECRET_KEY}`, date);
    const serviceKey = await sign(dateKey, 'tms');
    const signingKey = await sign(serviceKey, 'tc3_request');
    const signature = hex(await sign(signingKey, toSign));
    const response = await request(`https://${host}`, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        Authorization: `TC3-HMAC-SHA256 Credential=${config.TENCENT_SECRET_ID}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
        'X-TC-Action': 'TextModeration',
        'X-TC-Version': '2020-12-29',
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Region': config.TENCENT_REGION ?? 'ap-guangzhou',
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      report({ reason: 'http', status: response.status });
      return 'waiting';
    }
    const result = (await response.json()) as {
      Response?: { Suggestion?: string; RequestId?: string; Error?: { Code?: string } };
    };
    const requestId =
      typeof result.Response?.RequestId === 'string' ? result.Response.RequestId : undefined;
    if (result.Response?.Error) {
      // Never log the API message, request body or authentication headers.
      const code = result.Response.Error.Code;
      report({
        reason: 'api',
        code: typeof code === 'string' && /^[\w.]+$/u.test(code) ? code : undefined,
        requestId,
      });
      return 'waiting';
    }
    switch (result.Response?.Suggestion) {
      case 'Pass': {
        report({ reason: 'result', suggestion: 'Pass', requestId });
        return 'approved';
      }
      case 'Block': {
        report({ reason: 'result', suggestion: 'Block', requestId });
        return 'spam';
      }
      case 'Review': {
        report({ reason: 'result', suggestion: 'Review', requestId });
        return 'waiting';
      }
      default: {
        report({ reason: 'response', requestId });
        return 'waiting';
      }
    }
  } catch (err) {
    report({
      reason: 'request',
      code: err instanceof Error && err.name === 'TimeoutError' ? 'TimeoutError' : 'RequestFailed',
    });
    return 'waiting';
  }
};
