const os = require('node:os');
const path = require('node:path');

const Application = require('thinkjs');
// Keep the extension explicit so Wrangler's ESM bundler can resolve this
// CommonJS deep import when packaging the server for Cloudflare Workers.
const Loader = require('thinkjs/lib/loader.js');

module.exports = function main(configParams = {}) {
  const { env, ...config } = configParams;

  const app = new Application({
    ROOT_PATH: __dirname,
    APP_PATH: path.join(__dirname, 'src'),
    VIEW_PATH: path.join(__dirname, 'view'),
    RUNTIME_PATH: path.join(os.tmpdir(), 'runtime'),
    proxy: true, // use proxy
    env: env || 'vercel',
  });

  const loader = new Loader(app.options);

  loader.loadAll('worker');

  // oxlint-disable-next-line func-names
  return function (req, res) {
    for (const key in config) {
      // fix https://github.com/walinejs/waline/issues/2649 with alias model config name
      think.config(key === 'model' ? 'customModel' : key, config[key]);
    }

    return think
      .beforeStartServer()
      .catch((err) => {
        think.logger.error(err);
      })
      .then(() => {
        const callback = think.app.callback();

        return callback(req, res);
      })
      .then(() => {
        think.app.emit('appReady');
      });
  };
};
