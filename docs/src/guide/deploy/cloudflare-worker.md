---
title: Cloudflare Workers
icon: cloud
order: 5
---

# Cloudflare Workers

Waline 可以部署到 Cloudflare Workers，并使用 D1 保存评论和计数数据。

当前 Worker 版本面向前台评论场景，支持：

- 评论列表、发布评论、点赞和取消点赞
- 评论计数、最近评论
- 浏览量和文章反应计数

管理后台、用户登录、邮件通知、WebHook 和插件暂不支持，请继续使用 Vercel 或 Node.js
服务端运行这些功能。

## 创建数据库

克隆仓库后，必须先在项目根目录安装整个 pnpm workspace 的依赖：

```sh
pnpm install
```

不能只在 `packages/worker` 目录安装依赖，因为 Worker 会复用 `@waline/vercel`
服务端包及其 ThinkJS 依赖。安装完成后登录 Cloudflare：

```sh
pnpm exec wrangler login
pnpm --dir=packages/worker exec wrangler d1 create waline
```

将命令返回的 `database_id` 填入
`packages/worker/wrangler.jsonc` 的 `d1_databases[0].database_id`。

## 初始化 D1

本地开发数据库：

```sh
pnpm --dir=packages/worker db:migrate:local
pnpm worker:dev
```

线上数据库：

```sh
pnpm --dir=packages/worker db:migrate:remote
```

## 部署

确认 `database_id` 已替换后执行：

```sh
pnpm worker:deploy
```

部署完成后，将 Worker 地址作为客户端的 `serverURL`：

```js
Waline.init({
  el: '#waline',
  serverURL: 'https://waline.<你的子域>.workers.dev',
});
```

`SITE_NAME` 和日志采样率可以在 `wrangler.jsonc` 中调整。敏感值不要写入配置文件，
请使用 `wrangler secret put`。
