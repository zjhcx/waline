---
title: 腾讯云内容安全
icon: shield
---

Waline 支持使用腾讯云文本内容安全自动审核评论正文，适用于 Node 服务端和 Cloudflare Worker。

<!-- more -->

## 配置

在腾讯云开通[文本内容安全](https://cloud.tencent.com/document/api/1124/51860)，并配置业务审核策略。在部署环境设置以下变量，然后重新部署：

| 变量                 | 说明                                            |
| -------------------- | ----------------------------------------------- |
| `TENCENT_SECRET_ID`  | 腾讯云 API 密钥 ID，与 SecretKey 同时配置后启用 |
| `TENCENT_SECRET_KEY` | 腾讯云 API 密钥 SecretKey，仅在服务端保存       |
| `TENCENT_REGION`     | 可选，默认为 `ap-guangzhou`                     |
| `TENCENT_BIZ_TYPE`   | 可选，腾讯云控制台配置的业务策略 BizType        |

Cloudflare Worker 使用 `wrangler secret put TENCENT_SECRET_ID` 和 `wrangler secret put TENCENT_SECRET_KEY` 设置密钥，其余变量可在 Worker 环境变量中配置。请勿将密钥放入客户端配置或提交到仓库。

使用子账号密钥时，请为密钥所属子账号关联 `QcloudTMSFullAccess` 策略。`QcloudCMSFullAccess` 不能替代文本审核所需的权限；缺少授权会返回 `AuthFailure.UnauthorizedOperation`，详见[腾讯云官方说明](https://cloud.tencent.com/document/product/1124/64685)。

## 审核行为

所有用户（包括管理员）提交评论时，在写入数据库前审核；修改正文时也会重新审核。Worker 的正文编辑目前仅允许管理员操作。管理员只修改审核状态进行手动审批时，不会再次调用腾讯云。

测试前请确认部署环境变量名称为 `TENCENT_SECRET_ID` 和 `TENCENT_SECRET_KEY`，并重新部署。若控制台测试使用了自定义策略，请将同一个策略的 BizType 配置为 `TENCENT_BIZ_TYPE`；不设置该变量时使用腾讯云默认策略，审核结果可能与控制台所选策略不同。

| 腾讯云结果 | 评论状态                       |
| ---------- | ------------------------------ |
| `Pass`     | 通过；开启人工审核时仍为待审核 |
| `Review`   | 待审核                         |
| `Block`    | 垃圾评论                       |

接口超时、请求失败、响应异常、密钥仅配置一项，以及正文超过 10,000 个 Unicode 字符时，评论进入待审核，避免未经检查直接发布。接口超时为 10 秒。未配置两项密钥时不启用腾讯云审核。

腾讯云审核与现有敏感词、Akismet 检查共同生效，通过腾讯云审核不意味着跳过人工审核。Node 服务端已被标记为垃圾评论的内容不能通过用户编辑自动恢复。垃圾评论不会发送评论通知。

此功能仅审核文本正文，不审核 Markdown 引用的远程图片或附件。

## Worker 排查

在 Cloudflare Worker 的实时日志中搜索 `waline.tencent-moderation`。每次提交或修改正文会记录审核诊断，不包含密钥或评论正文。

| `reason`        | 含义                                                        |
| --------------- | ----------------------------------------------------------- |
| `result`        | 腾讯云正常返回，`suggestion` 为 `Pass`、`Review` 或 `Block` |
| `api`           | 腾讯云 API 错误；查看 `code` 和 `requestId`                 |
| `http`          | HTTP 错误；查看 `status`                                    |
| `request`       | 网络、解析或签名计算失败；`TimeoutError` 表示超时           |
| `configuration` | 只配置了一项密钥                                            |
| `disabled`      | 未读取到两项密钥，审核未启用                                |
| `length`        | 评论超过接口长度限制                                        |
| `response`      | 返回数据缺少有效审核结果                                    |

“待审核”同时可能来自 `Review` 或请求失败，不能仅凭评论状态判断腾讯云是否成功审核。若收到 `Pass`，但控制台测试为 `Block`，请核对两处的 BizType 和审核策略是否一致。
