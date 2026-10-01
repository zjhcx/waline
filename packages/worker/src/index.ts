import {
  HttpError,
  checkPassword,
  corsHeaders,
  csv,
  escapeHtml,
  fail,
  hashPassword,
  int,
  json,
  readBody,
  signToken,
  success,
  text,
  verifyCaptcha,
  verifyToken,
  type WorkerEnv,
} from './core.js';
import { TABLES, all, byId, insert, normalize, update, type Row } from './database.js';

type User = Row & {
  email: string;
  display_name: string;
  password: string;
  type: string;
  avatar: string | null;
  url: string | null;
  label: string | null;
};
type Comment = Row & {
  comment: string;
  insertedAt: string;
  ip: string | null;
  link: string | null;
  mail: string | null;
  nick: string | null;
  rid: number | null;
  pid: number | null;
  sticky: number;
  status: string;
  like: number;
  ua: string | null;
  url: string;
  user_id: number | null;
};

const COUNTERS = new Set([
  'time',
  'reaction0',
  'reaction1',
  'reaction2',
  'reaction3',
  'reaction4',
  'reaction5',
  'reaction6',
  'reaction7',
  'reaction8',
]);

const jwtSecret = (env: WorkerEnv) => {
  if (!env.JWT_TOKEN) throw new HttpError(500, 'JWT_TOKEN secret is not configured');
  return env.JWT_TOKEN;
};

async function currentUser(request: Request, env: WorkerEnv) {
  const token =
    request.headers.get('authorization')?.replace(/^Bearer\s+/iu, '') ??
    new URL(request.url).searchParams.get('token') ??
    '';
  if (!token || !env.JWT_TOKEN) return null;
  const id = await verifyToken(token, env.JWT_TOKEN);
  return id
    ? (byId<User>(env.DB, 'Users', id) as Promise<(Omit<User, 'id'> & { objectId: number }) | null>)
    : null;
}

const requireUser = async (request: Request, env: WorkerEnv, admin = false) => {
  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, 'Unauthorized');
  if (admin && user.type !== 'administrator') throw new HttpError(403, 'Forbidden');
  return user;
};

function commentView(row: Omit<Comment, 'id'> & { objectId: number }, user?: unknown) {
  const output: Record<string, unknown> = {
    objectId: row.objectId,
    user_id: row.user_id,
    comment: escapeHtml(String(row.comment)).replaceAll('\n', '<br>'),
    nick: row.nick ?? '',
    link: row.link ?? '',
    pid: row.pid,
    rid: row.rid,
    sticky: Boolean(row.sticky),
    like: Number(row.like) || 0,
    url: row.url,
    avatar: '',
    browser: '',
    os: '',
    type: '',
    time: new Date(`${String(row.insertedAt).replace(' ', 'T')}Z`).getTime(),
  };
  if (user) output.orig = row.comment;
  return output;
}

async function comments(request: Request, env: WorkerEnv, ctx: ExecutionContext, url: URL) {
  const user = await currentUser(request, env);
  const id = Number(url.pathname.match(/^\/api\/comment\/(\d+)$/u)?.[1]);
  if (request.method === 'GET' && url.pathname.endsWith('/rss')) return rss(env, url);

  if (request.method === 'GET' && url.searchParams.get('type') === 'count') {
    const paths = csv(url.searchParams.get('url'));
    if (paths.length === 0) return success(0);
    const result = await env.DB.prepare(
      `SELECT url, COUNT(*) count FROM wl_Comment WHERE status = 'approved'
       AND url IN (SELECT value FROM json_each(?)) GROUP BY url`,
    )
      .bind(JSON.stringify(paths))
      .all<{ url: string; count: number }>();
    const map = new Map(result.results.map((item) => [item.url, item.count]));
    const data = paths.map((path) => map.get(path) ?? 0);
    return success(paths.length === 1 ? data[0] : data);
  }

  if (request.method === 'GET' && url.searchParams.get('type') === 'recent') {
    const limit = int(url.searchParams.get('count'), 10, 50);
    const rows = await env.DB.prepare(
      `SELECT * FROM wl_Comment WHERE status = 'approved' ORDER BY insertedAt DESC LIMIT ?`,
    )
      .bind(limit)
      .all<Comment>();
    return json(rows.results.map((row) => commentView(normalize(row), user)));
  }

  if (request.method === 'GET' && url.searchParams.get('type') === 'list') {
    await requireUser(request, env, true);
    const page = int(url.searchParams.get('page'), 1, 1_000_000);
    const pageSize = int(url.searchParams.get('pageSize'), 10);
    const status = url.searchParams.get('status');
    const keyword = url.searchParams.get('keyword');
    const clauses = ['1=1'];
    const values: unknown[] = [];
    if (status) {
      clauses.push('status = ?');
      values.push(status);
    }
    if (keyword) {
      clauses.push('comment LIKE ?');
      values.push(`%${keyword}%`);
    }
    const where = clauses.join(' AND ');
    const [count, spam, waiting, rows] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) count FROM wl_Comment WHERE ${where}`)
        .bind(...values)
        .first<{ count: number }>(),
      env.DB.prepare(`SELECT COUNT(*) count FROM wl_Comment WHERE status='spam'`).first<{
        count: number;
      }>(),
      env.DB.prepare(`SELECT COUNT(*) count FROM wl_Comment WHERE status='waiting'`).first<{
        count: number;
      }>(),
      env.DB.prepare(
        `SELECT * FROM wl_Comment WHERE ${where} ORDER BY insertedAt DESC LIMIT ? OFFSET ?`,
      )
        .bind(...values, pageSize, (page - 1) * pageSize)
        .all<Comment>(),
    ]);
    return success({
      page,
      pageSize,
      totalPages: Math.ceil((count?.count ?? 0) / pageSize),
      spamCount: spam?.count ?? 0,
      waitingCount: waiting?.count ?? 0,
      data: rows.results.map((row) => ({
        ...commentView(normalize(row), user),
        status: row.status,
        ip: row.ip,
        mail: row.mail,
        ua: row.ua,
      })),
    });
  }

  if (request.method === 'GET') {
    const path = url.searchParams.get('path');
    if (!path) throw new HttpError(400, 'path is required');
    const page = int(url.searchParams.get('page'), 1, 1_000_000);
    const pageSize = int(url.searchParams.get('pageSize'), 10);
    const sort =
      url.searchParams.get('sortBy') === 'insertedAt_asc'
        ? 'insertedAt ASC'
        : url.searchParams.get('sortBy') === 'like_desc'
          ? '"like" DESC'
          : 'insertedAt DESC';
    const rows = await env.DB.prepare(
      `SELECT * FROM wl_Comment WHERE url=? AND status='approved' ORDER BY sticky DESC, ${sort}`,
    )
      .bind(path)
      .all<Comment>();
    const roots = rows.results.filter((row) => !row.rid);
    const selected = roots.slice((page - 1) * pageSize, page * pageSize);
    const ids = new Set(selected.map((row) => row.id));
    return success({
      page,
      pageSize,
      count: rows.results.length,
      totalPages: Math.ceil(roots.length / pageSize),
      data: selected.map((row) => ({
        ...commentView(normalize(row), user),
        children: rows.results
          .filter((child) => child.rid === row.id && ids.has(row.id))
          .map((child) => commentView(normalize(child), user))
          .reverse(),
      })),
    });
  }

  if (request.method === 'POST') {
    const data = await readBody(request);
    await verifyCaptcha(request, env, data.turnstile, data.cap);
    const comment = text(data.comment);
    const path = text(data.url, 2048);
    const nick = text(data.nick, 100);
    if (!comment || !path || !nick) throw new HttpError(400, 'comment, url and nick are required');
    const mail = text(data.mail, 320).toLowerCase();
    const ip = request.headers.get('CF-Connecting-IP') ?? '';
    const duplicate = await env.DB.prepare(
      `SELECT id FROM wl_Comment WHERE url=? AND mail=? AND nick=? AND comment=? LIMIT 1`,
    )
      .bind(path, mail, nick, comment)
      .first();
    if (duplicate) throw new HttpError(400, 'Duplicate Content');
    const row = await insert(env.DB, 'Comment', {
      comment,
      url: path,
      nick,
      mail,
      link: text(data.link, 2048),
      ua: text(data.ua, 1000),
      ip,
      pid: Number(data.pid) || null,
      rid: Number(data.rid) || null,
      user_id: user?.objectId ?? null,
      status:
        env.COMMENT_AUDIT === 'true' && user?.type !== 'administrator' ? 'waiting' : 'approved',
    });
    if (env.WEBHOOK && row) {
      ctx.waitUntil(
        fetch(env.WEBHOOK, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'new_comment', data: row }),
        }),
      );
    }
    return success(row ? commentView(row as never, user) : null);
  }

  if (request.method === 'PUT' && Number.isInteger(id)) {
    const data = await readBody(request);
    const existing = await byId<Comment>(env.DB, 'Comment', id);
    if (!existing) throw new HttpError(404, 'Comment not found');
    if (typeof data.like === 'boolean' && Object.keys(data).length === 1) {
      const row = await env.DB.prepare(
        `UPDATE wl_Comment SET "like"=MAX(0,"like"+?),updatedAt=datetime('now') WHERE id=? RETURNING *`,
      )
        .bind(data.like ? 1 : -1, id)
        .first<Comment>();
      return success(row ? commentView(normalize(row), user) : null);
    }
    await requireUser(request, env, true);
    const allowed = Object.fromEntries(
      Object.entries(data).filter(([key]) =>
        ['comment', 'nick', 'mail', 'link', 'url', 'status', 'sticky'].includes(key),
      ),
    );
    const row = await update(env.DB, 'Comment', id, allowed);
    return success(row ? commentView(row as never, user) : null);
  }

  if (request.method === 'DELETE' && Number.isInteger(id)) {
    await requireUser(request, env, true);
    await env.DB.prepare('DELETE FROM wl_Comment WHERE id=? OR pid=? OR rid=?')
      .bind(id, id, id)
      .run();
    return success();
  }
  throw new HttpError(405, 'Method not allowed');
}

async function article(request: Request, env: WorkerEnv, url: URL) {
  if (request.method === 'GET') {
    const paths = csv(url.searchParams.get('path'));
    const fields = csv(url.searchParams.get('type')).filter((field) => COUNTERS.has(field));
    const rows = paths.length
      ? await env.DB.prepare(
          'SELECT * FROM wl_Counter WHERE url IN (SELECT value FROM json_each(?))',
        )
          .bind(JSON.stringify(paths))
          .all<Record<string, number | string>>()
      : { results: [] };
    const map = new Map(rows.results.map((row) => [String(row.url), row]));
    return success(
      paths.map((path) =>
        Object.fromEntries(fields.map((field) => [field, Number(map.get(path)?.[field]) || 0])),
      ),
    );
  }
  const data = await readBody(request);
  const path = text(data.path, 2048);
  const field = text(data.type, 20);
  if (!path || !COUNTERS.has(field)) throw new HttpError(400, 'Invalid counter');
  await env.DB.prepare('INSERT INTO wl_Counter(url) VALUES(?) ON CONFLICT(url) DO NOTHING')
    .bind(path)
    .run();
  const row = await env.DB.prepare(
    `UPDATE wl_Counter SET "${field}"=MAX(0,"${field}"+?),updatedAt=datetime('now') WHERE url=? RETURNING "${field}" value`,
  )
    .bind(data.action === 'desc' ? -1 : 1, path)
    .first<{ value: number }>();
  return success([{ [field]: row?.value ?? 0 }]);
}

async function token(request: Request, env: WorkerEnv) {
  if (request.method === 'GET') return success(await requireUser(request, env));
  if (request.method === 'DELETE') return success();
  const data = await readBody(request);
  await verifyCaptcha(request, env, data.turnstile, data.cap);
  const email = text(data.email, 320).toLowerCase();
  const user = await env.DB.prepare('SELECT * FROM wl_Users WHERE email=? LIMIT 1')
    .bind(email)
    .first<User>();
  if (
    !user ||
    user.type === 'banned' ||
    user.type.startsWith('verify:') ||
    !(await checkPassword(text(data.password), user.password))
  )
    throw new HttpError(403, 'Invalid email or password');
  const normalized = normalize(user);
  return success({
    ...normalized,
    password: null,
    token: await signToken(user.id, jwtSecret(env)),
  });
}

async function users(request: Request, env: WorkerEnv, url: URL) {
  const id = Number(url.pathname.match(/^\/api\/user\/(\d+)$/u)?.[1]);
  const user = await currentUser(request, env);
  if (request.method === 'POST') {
    const data = await readBody(request);
    await verifyCaptcha(request, env, data.turnstile, data.cap);
    const email = text(data.email, 320).toLowerCase();
    const password = text(data.password);
    const name = text(data.display_name, 100);
    if (!email || !password || !name)
      throw new HttpError(400, 'display_name, email and password are required');
    const exists = await env.DB.prepare('SELECT id FROM wl_Users WHERE email=?')
      .bind(email)
      .first();
    if (exists) throw new HttpError(409, 'User exists');
    const count = await env.DB.prepare('SELECT COUNT(*) count FROM wl_Users').first<{
      count: number;
    }>();
    await insert(env.DB, 'Users', {
      display_name: name,
      email,
      password: await hashPassword(password),
      url: text(data.url, 2048),
      type: count?.count ? 'guest' : 'administrator',
    });
    return success();
  }
  if (request.method === 'GET' && user?.type === 'administrator') {
    const page = int(url.searchParams.get('page'), 1, 1_000_000);
    const pageSize = int(url.searchParams.get('pageSize'), 10);
    const email = url.searchParams.get('email');
    if (email) {
      const row = await env.DB.prepare('SELECT * FROM wl_Users WHERE email=?')
        .bind(email)
        .first<User>();
      return success(row ? normalize(row) : null);
    }
    const count = await env.DB.prepare('SELECT COUNT(*) count FROM wl_Users').first<{
      count: number;
    }>();
    const rows = await env.DB.prepare(
      'SELECT * FROM wl_Users ORDER BY createdAt DESC LIMIT ? OFFSET ?',
    )
      .bind(pageSize, (page - 1) * pageSize)
      .all<User>();
    return success({
      page,
      pageSize,
      totalPages: Math.ceil((count?.count ?? 0) / pageSize),
      data: rows.results.map(({ password: _, ...row }) => normalize(row as User)),
    });
  }
  if (request.method === 'GET') {
    const pageSize = int(url.searchParams.get('pageSize'), 20, 50);
    const rows = await env.DB.prepare(
      `SELECT mail,user_id,COUNT(*) count FROM wl_Comment WHERE status='approved' GROUP BY user_id,mail ORDER BY count DESC LIMIT ?`,
    )
      .bind(pageSize)
      .all<{ mail: string; user_id: number; count: number }>();
    return success(
      rows.results.map((row) => ({ count: row.count, nick: row.mail, link: '', avatar: '' })),
    );
  }
  const actor = await requireUser(request, env);
  const target = Number.isInteger(id) ? id : actor.objectId;
  if (target !== actor.objectId && actor.type !== 'administrator')
    throw new HttpError(403, 'Forbidden');
  if (request.method === 'PUT') {
    const data = await readBody(request);
    const allowed: Record<string, unknown> = Object.fromEntries(
      Object.entries(data).filter(([key]) =>
        [
          'display_name',
          'email',
          'url',
          'avatar',
          'type',
          'label',
          'github',
          'twitter',
          'facebook',
          'google',
          'weibo',
          'qq',
          'oidc',
          'huawei',
          '2fa',
        ].includes(key),
      ),
    );
    if (data.password) allowed.password = await hashPassword(text(data.password));
    await update(env.DB, 'Users', target, allowed);
    return success();
  }
  if (request.method === 'DELETE') {
    if (actor.type !== 'administrator' || target === actor.objectId)
      throw new HttpError(403, 'Forbidden');
    await update(env.DB, 'Users', target, { type: 'banned' });
    return success();
  }
  throw new HttpError(405, 'Method not allowed');
}

async function database(request: Request, env: WorkerEnv, url: URL) {
  await requireUser(request, env, true);
  const table = url.searchParams.get('table') as keyof typeof TABLES | null;
  if (request.method === 'GET')
    return success({
      type: 'waline',
      version: 1,
      time: Date.now(),
      tables: Object.keys(TABLES),
      data: {
        Comment: await all(env.DB, 'Comment'),
        Counter: await all(env.DB, 'Counter'),
        Users: await all(env.DB, 'Users'),
      },
    });
  if (!table || !(table in TABLES)) throw new HttpError(400, 'Invalid table');
  if (request.method === 'DELETE') {
    await env.DB.prepare(`DELETE FROM "${TABLES[table]}"`).run();
    return success();
  }
  const data = await readBody(request);
  if (request.method === 'POST') return success(await insert(env.DB, table, data));
  const id = Number(url.searchParams.get('objectId'));
  if (request.method === 'PUT' && id) return success(await update(env.DB, table, id, data));
  throw new HttpError(405, 'Method not allowed');
}

async function oauth(request: Request, env: WorkerEnv, url: URL) {
  const type = url.searchParams.get('type') ?? '';
  const code = url.searchParams.get('code');
  const redirect = url.searchParams.get('redirect');
  if (!/^[a-z][a-z0-9_-]+$/u.test(type)) throw new HttpError(400, 'Invalid OAuth provider');
  if (!code) {
    const callback = new URL('/api/oauth', url.origin);
    callback.searchParams.set('type', type);
    if (redirect) callback.searchParams.set('redirect', redirect);
    const target = new URL(`${env.OAUTH_URL.replace(/\/$/u, '')}/${type}`);
    target.searchParams.set('redirect', callback.toString());
    return Response.redirect(target.toString());
  }
  const provider = new URL(`${env.OAUTH_URL.replace(/\/$/u, '')}/${type}`);
  provider.searchParams.set('code', code);
  const profile = (await fetch(provider, { headers: { 'user-agent': '@waline' } }).then(
    (response) => response.json(),
  )) as Record<string, unknown>;
  if (!profile.id) throw new HttpError(400, 'OAuth failed');
  let user = await env.DB.prepare(`SELECT * FROM wl_Users WHERE "${type}"=?`)
    .bind(String(profile.id))
    .first<User>();
  if (!user) {
    const count = await env.DB.prepare('SELECT COUNT(*) count FROM wl_Users').first<{
      count: number;
    }>();
    const created = await insert(env.DB, 'Users', {
      display_name: text(profile.name, 100),
      email: text(profile.email, 320),
      url: text(profile.url, 2048),
      avatar: text(profile.avatar, 2048),
      [type]: String(profile.id),
      password: await hashPassword(crypto.randomUUID()),
      type: count?.count ? 'guest' : 'administrator',
    });
    user = created ? ({ ...created, id: created.objectId } as unknown as User) : null;
  }
  if (!user) throw new HttpError(500, 'OAuth account creation failed');
  const token = await signToken(user.id, jwtSecret(env));
  if (redirect) {
    const target = new URL(redirect);
    target.searchParams.set('token', token);
    return Response.redirect(target.toString());
  }
  return success();
}

async function rss(env: WorkerEnv, url: URL) {
  const limit = int(url.searchParams.get('count'), 20, 50);
  const path = url.searchParams.get('path');
  const result = await env.DB.prepare(
    `SELECT * FROM wl_Comment WHERE status='approved' ${path ? 'AND url=?' : ''} ORDER BY insertedAt DESC LIMIT ?`,
  )
    .bind(...(path ? [path, limit] : [limit]))
    .all<Comment>();
  const site = env.SITE_URL || url.origin;
  const items = result.results
    .map(
      (row) =>
        `<item><title>${escapeHtml(`${row.nick || 'Anonymous'} commented on ${row.url}`)}</title><link>${escapeHtml(`${new URL(row.url, site)}#${row.id}`)}</link><guid>${row.id}</guid><pubDate>${new Date(`${row.insertedAt}Z`).toUTCString()}</pubDate><description><![CDATA[${escapeHtml(row.comment)}]]></description></item>`,
    )
    .join('');
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${escapeHtml(env.SITE_NAME)} Comments</title><link>${escapeHtml(site)}</link><description>Recent comments.</description>${items}</channel></rss>`,
    { headers: { ...corsHeaders, 'content-type': 'application/rss+xml; charset=utf-8' } },
  );
}

function ui(env: WorkerEnv, url: URL) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(env.SITE_NAME)}</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script>window.SITE_URL=${JSON.stringify(env.SITE_URL)};window.SITE_NAME=${JSON.stringify(env.SITE_NAME)};window.serverURL=${JSON.stringify(`${url.origin}/api/`)};window.capApiEndpoint=${JSON.stringify(env.CAP_API_ENDPOINT || '')};window.capWidgetUrl=${JSON.stringify(env.CAP_WIDGET_URL || '')};</script><script src="//unpkg.com/@waline/admin"></script></body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

function homepage(env: WorkerEnv, url: URL) {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Waline Example</title>
</head>
<body>
  <div id="waline" style="max-width: 800px;margin: 0 auto;"></div>
  <link href="//unpkg.com/@waline/client@v3/dist/waline.css" rel="stylesheet">
  <script type="module">
    import { init } from 'https://unpkg.com/@waline/client@v3/dist/waline.js';

    console.log(
      '%c @waline/server %c v1.41.3-worker ',
      'color: white; background: #0078E7; padding:5px 0;',
      'padding:4px;border:1px solid #0078E7;'
    );
    const params = new URLSearchParams(location.search.slice(1));
    init({
      el: '#waline',
      path: params.get('path') || '/',
      lang: params.get('lng') || undefined,
      serverURL: ${JSON.stringify(url.origin)},
      recaptchaV3Key: ${JSON.stringify(env.RECAPTCHA_V3_KEY || '')},
      capApiEndpoint: ${JSON.stringify(env.CAP_API_ENDPOINT || '')},
      capWidgetUrl: ${JSON.stringify(env.CAP_WIDGET_URL || '')},
      turnstileKey: ${JSON.stringify(env.TURNSTILE_KEY || '')},
    });
  </script>
</body>
</html>`,
    {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'x-waline-version': '1.41.3-worker',
      },
    },
  );
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: corsHeaders });
    try {
      if (url.pathname === '/') return homepage(env, url);
      if (url.pathname === '/ui' || url.pathname.startsWith('/ui/')) return ui(env, url);
      if (/^\/api\/comment(?:\/rss|\/\d+)?$/u.test(url.pathname))
        return await comments(request, env, ctx, url);
      if (url.pathname === '/api/article') return await article(request, env, url);
      if (url.pathname === '/api/token') return await token(request, env);
      if (/^\/api\/user(?:\/\d+)?$/u.test(url.pathname)) return await users(request, env, url);
      if (url.pathname === '/api/db') return await database(request, env, url);
      if (url.pathname === '/api/oauth') return await oauth(request, env, url);
      if (url.pathname === '/api/verification')
        return fail('Registration verification requires an email provider', 501);
      if (url.pathname === '/api/token/2fa')
        return fail('Two-factor authentication setup is not configured', 501);
      if (url.pathname === '/api/user/password')
        return fail('Password email delivery is not configured', 501);
      throw new HttpError(404, 'Not found');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      console.error(
        JSON.stringify({
          message: 'request failed',
          method: request.method,
          path: url.pathname,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return fail(error instanceof Error ? error.message : 'Internal Server Error', status);
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
