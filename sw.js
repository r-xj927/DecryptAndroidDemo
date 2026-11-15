// web/sw.js
// 离线缓存：把 Flutter 引擎、CanvasKit、解密 Worker 及其依赖预缓存，
// 使页面在断网时仍能启动并完成解密（私钥本来就在 main.dart.js 里，全程不联网）。
//
// 版本号来自注册 URL 的 ?v=...（由 web/flutter_bootstrap.js 注入），
// 每次 flutter build web 自动变化，activate 时清掉旧缓存。
//
// 刻意不缓存：
//   - downloads/ 下的 34MB 桌面安装包（断网也用不上）
//   - assets/NOTICES（1.38MB，浏览器本来就不请求）
//   - 被部署脚本剪掉的 skwasm / wimp / webparagraph 变体
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE_NAME = 'decrypt-offline-' + VERSION;
const CACHE_PREFIX = 'decrypt-offline-';
const SCOPE = self.registration.scope; // 例：https://xxx.github.io/DecryptAndroidDemo/

// 本地 dev server（flutter run -d chrome）用 DDC 模块，预缓存清单里那些
// release 文件名根本不存在；拦截请求只会拖慢刷新、干扰热重载。
// 这里让旧 SW 自愈：清掉自己的缓存并注销，之后完全不接管请求。
const IS_DEV = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(self.location.hostname);

const asset = (path) => new URL(path, SCOPE).toString();

// 两套 CanvasKit 都缓存（约 12.8MB）：Chromium 走 chromium/ 变体，
// Safari / Firefox 走通用版。多缓存一份换取「任何浏览器都能离线打开」。
const PRECACHE = [
  '', // scope 根，即 index.html
  'index.html',
  'flutter_bootstrap.js',
  'flutter.js',
  'main.dart.js',
  'manifest.json',
  'favicon.png',
  'version.json',
  'decrypt_worker.js',
  'fflate.min.js',
  'crypto-js.min.js',
  'canvaskit/canvaskit.js',
  'canvaskit/canvaskit.wasm',
  'canvaskit/chromium/canvaskit.js',
  'canvaskit/chromium/canvaskit.wasm',
  'icons/Icon-192.png',
  'icons/Icon-512.png',
  'icons/Icon-maskable-192.png',
  'icons/Icon-maskable-512.png',
  'assets/AssetManifest.bin',
  'assets/AssetManifest.bin.json',
  'assets/FontManifest.json',
  'assets/fonts/MaterialIcons-Regular.otf',
  'assets/fonts/fallback/Roboto-Regular.ttf',
  'assets/packages/cupertino_icons/assets/CupertinoIcons.ttf',
  'assets/shaders/ink_sparkle.frag',
  'assets/shaders/stretch_effect.frag',
  'assets/assets/tray_icon.ico',
  'assets/assets/tray_icon_mac.png'
];

self.addEventListener('install', (event) => {
  if (IS_DEV) {
    event.waitUntil(self.skipWaiting());
    return;
  }
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // 逐个 add：部署脚本剪枝后个别文件可能不存在，任一 404 不能拖垮整批
    await Promise.all(PRECACHE.map(async (path) => {
      try {
        await cache.add(new Request(asset(path), { cache: 'reload' }));
      } catch (e) {
        // 资源缺失或网络中断都忽略，离线时按需回源失败即可
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  if (IS_DEV) {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys
        .filter((key) => key.startsWith(CACHE_PREFIX))
        .map((key) => caches.delete(key)));
      await self.registration.unregister();
      await self.clients.claim();
    })());
    return;
  }
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (IS_DEV) return; // dev server：完全不接管请求
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // 安装包按需下载，绝不进离线缓存（否则白白吃掉 34MB 配额）
  if (url.pathname.indexOf('/downloads/') !== -1) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;

    try {
      const response = await fetch(request);
      // 同源的成功响应顺手缓存，覆盖构建后新增的散文件
      if (response.ok && response.type === 'basic') {
        await cache.put(request, response.clone());
      }
      return response;
    } catch (e) {
      if (request.mode === 'navigate') {
        const fallback = await cache.match(asset('index.html'));
        if (fallback) return fallback;
      }
      return Response.error();
    }
  })());
});

// 页面可查询「离线资源是否就绪」（预留给低调的状态标记，不弹窗打扰）
self.addEventListener('message', (event) => {
  if (event.data !== 'DECRYPT_OFFLINE_READY') return;
  event.waitUntil(caches.open(CACHE_NAME)
    .then((cache) => cache.keys())
    .then((keys) => {
      if (event.source) {
        event.source.postMessage({
          type: 'DECRYPT_OFFLINE_READY',
          count: keys.length
        });
      }
    }));
});
