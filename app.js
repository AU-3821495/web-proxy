const express = require('express');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');
const cheerio = require('cheerio');
const url = require('url'); // Node.jsの組み込みモジュール

const app = express();
const port = process.env.PORT || 3000; // Render.comはPORT環境変数を使用

// 許可ホストリスト（3000件追加可能。education用に例を追加）
const APPROVED_HOSTS = [
  'www.google.com', 'google.com', 'www.youtube.com', 'youtube.com',
  'www.khanacademy.org', 'khanacademy.org' // ここに3000件のドメインを追加
  // 例: 'example1.com', 'example2.com', ... (最大3000件まで配列に追加)
];

// 静的ファイル（HTML/CSS）をpublicフォルダから配信
app.use(express.static('public'));

// ルート: UIを表示
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// プロキシルート: /p/<host>/<path>
app.use('/p/:host*', (req, res, next) => {
  const host = req.params.host;
  if (!APPROVED_HOSTS.includes(host)) {
    return res.status(403).send('このホストは許可されていません。');
  }

  const targetPath = req.params[0] || '/';
  const target = `http://${host}${targetPath}`; // HTTPSが必要なら'https://'に変更（証明書注意）

  const proxy = createProxyMiddleware({
    target: target,
    changeOrigin: true,
    selfHandleResponse: true, // レスポンスをインターセプト
    pathRewrite: (path) => path.replace(/^\/p\/[^/]+/, ''), // /p/hostを削除
    on: {
      proxyRes: responseInterceptor(async (buffer, proxyRes, req, res) => {
        const contentType = proxyRes.headers['content-type'];
        if (contentType && contentType.includes('text/html')) {
          // HTMLの場合、URLを書き換え（iFrame/埋め込み対応）
          let html = buffer.toString('utf8');
          const $ = cheerio.load(html);
          const baseUrl = `http://${req.headers.host}/p/${host}`;

          // リンク、画像、スクリプト、iFrame、動画などのURLをプロキシ経由に書き換え
          $('a[href], link[href], script[src], img[src], iframe[src], video[src], audio[src], source[src], form[action]').each((i, el) => {
            let attr = '';
            if (el.tagName === 'a' || el.tagName === 'link') attr = 'href';
            else if (el.tagName === 'form') attr = 'action';
            else attr = 'src';

            let origUrl = $(el).attr(attr);
            if (origUrl) {
              // 相対URLを絶対URLに変換
              const parsedUrl = url.resolve(target, origUrl);
              const urlObj = new URL(parsedUrl);
              // プロキシ経由のURLに書き換え
              $(el).attr(attr, `/p/${urlObj.host}${urlObj.pathname}${urlObj.search}`);
            }
          });

          html = $.html();
          // content-lengthを更新
          res.set('content-length', Buffer.byteLength(html, 'utf8'));
          return html;
        }
        // 非HTML（静的/動的/ストリーム）はそのまま返却（ストリーミング対応）
        return buffer;
      }),
    },
  });

  proxy(req, res, next);
});

app.listen(port, () => {
  console.log(`サーバーがポート${port}で起動しました`);
});
