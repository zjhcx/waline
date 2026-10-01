export type WorkerEnv = Env & {
  JWT_TOKEN?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_KEY?: string;
  RECAPTCHA_V3_KEY?: string;
  WEBHOOK?: string;
  SITE_URL: string;
  OAUTH_URL: string;
  COMMENT_AUDIT: string;
};

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const corsHeaders = {
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'x-waline-version',
};

export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { ...corsHeaders, 'x-waline-version': '1.41.3-worker' },
  });
}

export const success = (data: unknown = '') => json({ errno: 0, errmsg: '', data });
export const fail = (message = 'Operation failed', status = 400) =>
  json({ errno: status, errmsg: message }, status);

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.includes('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  const body: unknown = await request.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'JSON body must be an object');
  }
  return body as Record<string, unknown>;
}

export const int = (value: string | null, fallback: number, max = 100) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), max) : fallback;
};

export const text = (value: unknown, max = 10_000) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

export const csv = (value: string | null) =>
  value?.split(',').map((item) => decodeURIComponent(item)).filter(Boolean) ?? [];

export const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const encoder = new TextEncoder();
const base64url = (input: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(input)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
const decode64url = (input: string) => {
  const value = input.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(value.padEnd(Math.ceil(value.length / 4) * 4, '=')), (c) =>
    c.charCodeAt(0),
  );
};

async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  return crypto.subtle.sign('HMAC', key, encoder.encode(value));
}

export async function signToken(userId: number, secret: string) {
  const header = base64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64url(
    encoder.encode(JSON.stringify({ sub: userId, iat: Math.floor(Date.now() / 1000) })),
  );
  return `${header}.${payload}.${base64url(await hmac(secret, `${header}.${payload}`))}`;
}

export async function verifyToken(token: string, secret: string): Promise<number | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = new Uint8Array(await hmac(secret, `${parts[0]}.${parts[1]}`));
  const actual = decode64url(parts[2]);
  if (expected.length !== actual.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected[i] ^ actual[i];
  if (diff !== 0) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(decode64url(parts[1])));
    return Number(payload.sub) || null;
  } catch {
    return null;
  }
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    key,
    256,
  );
  return `pbkdf2$100000$${base64url(salt)}$${base64url(hash)}`;
}

export async function checkPassword(password: string, stored: string) {
  const [kind, iterations, salt, expected] = stored.split('$');
  if (kind !== 'pbkdf2' || !salt || !expected) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const actual = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: decode64url(salt),
        iterations: Number(iterations),
        hash: 'SHA-256',
      },
      key,
      256,
    ),
  );
  const wanted = decode64url(expected);
  if (actual.length !== wanted.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) diff |= actual[i] ^ wanted[i];
  return diff === 0;
}

export async function verifyCaptcha(request: Request, env: WorkerEnv, token: unknown) {
  if (!env.TURNSTILE_SECRET) return;
  if (typeof token !== 'string') throw new HttpError(403, 'Captcha required');
  const form = new FormData();
  form.set('secret', env.TURNSTILE_SECRET);
  form.set('response', token);
  form.set('remoteip', request.headers.get('CF-Connecting-IP') ?? '');
  const result = (await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  }).then((response) => response.json())) as { success?: boolean };
  if (!result.success) throw new HttpError(403, 'Captcha verification failed');
}
