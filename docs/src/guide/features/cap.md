# Cap 验证码

Waline 支持 [Cap Standalone](https://capjs.js.org/guide/standalone/)，用于评论提交、管理后台登录和注册。Cap 使用后台计算验证，无需点击验证码。

在 Cap 控制台创建站点，取得站点 key 和对应的 secret key。

## 服务端

配置以下环境变量（Node 服务端）：

| 环境变量           | 说明                                                            |
| ------------------ | --------------------------------------------------------------- |
| `CAP_API_ENDPOINT` | 带站点 key 的公开端点，例如 `https://cap.example.com/site-key/` |
| `CAP_SECRET`       | 此站点的 secret key，不是 Cap 控制台的管理员密码                |
| `CAP_WIDGET_URL`   | 可选，自托管 Cap widget 脚本 URL，管理后台和示例页面使用        |

服务端向 `${CAP_API_ENDPOINT}/siteverify` 发送令牌进行校验。缺少令牌、配置不完整、验证失败或网络异常时拒绝请求。Cap 配置优先于 Turnstile 和 reCAPTCHA。

## 客户端

```js
init({
  el: '#waline',
  serverURL: 'https://waline.example.com',
  capApiEndpoint: 'https://cap.example.com/site-key/',
  // 可选：自托管脚本，避免依赖公共 CDN
  // capWidgetUrl: 'https://cap.example.com/assets/widget.js',
});
```

客户端端点应与服务端配置的站点一致。secret 只配置在服务端，不得传给客户端。管理后台与示例页面自动读取服务端配置；自行集成的评论客户端需显式配置上述选项，并使用包含 Cap 支持的客户端构建。
