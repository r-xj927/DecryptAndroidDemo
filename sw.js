// web/sw.js
// 离线缓存：把 Flutter 引擎、CanvasKit、解密 Worker 及其依赖预缓存，
// 使页面在断网时仍能启动并完成解密（私钥本来就在 main.dart.js 里，全程不联网）。
//
// 版本号来自注册 URL 的 ?v=...（由 web/flutter_bootstrap.js 注入），
// 每次 flutter build web 自动变化，activate 时清掉旧缓存。
//
// ---------------------------------------------------------------------------
// 缓存策略（关键：入口文件必须网络优先，否则会「永远更新不到新版本」）
//
// Flutter 产物的文件名是固定的（main.dart.js、flutter_bootstrap.js、
// index.html，都没有内容哈希）。如果把它们也按普通静态资源做缓存优先，
// 会形成死锁：
//   旧 SW 缓存优先 → 永远吐旧 index.html
//   → 旧 HTML 只注册旧版本号的 sw.js?v=...
//   → 浏览器认为脚本没变，不更新 SW
//   → 缓存里永远是旧的那一套，刷新多少次都是旧版本
// iOS Safari 不主动检查 SW 更新，这个死锁尤其顽固。
//
// 所以拆成三档：
//   1. 入口文件（NETWORK_FIRST）：先取网络，超时才回落缓存；
//   2. version.json：永不缓存，它就是「有没有新版本」的判据；
//   3. 其余静态资源：缓存优先 + 后台更新（省流量、离线可用）。
// ---------------------------------------------------------------------------
//
// 刻意不缓存：
//   - downloads/ 下的 34MB 桌面安装包（断网也用不上）
//   - assets/NOTICES（1.38MB，浏览器本来就不请求）
//   - 被部署脚本剪掉的 skwasm / wimp / webparagraph 变体
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE_NAME = 'decrypt-offline-' + VERSION;
const CACHE_PREFIX = 'decrypt-offline-';
const SCOPE = self.registration.scope; // 例：https://xxx.github.io/DecryptAndroidDemo/
const SCOPE_PATH = new URL(SCOPE).pathname;

// 本地 dev server（flutter run -d chrome）用 DDC 模块，预缓存清单里那些
// release 文件名根本不存在；拦截请求只会拖慢刷新、干扰热重载。
// 这里让旧 SW 自愈：清掉自己的缓存并注销，之后完全不接管请求。
const IS_DEV = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(self.location.hostname);

const asset = (path) => new URL(path, SCOPE).toString();

// 入口文件：每次发布都可能变、且文件名不带哈希 → 必须网络优先。
// 超时回落缓存是为了弱网/断网时仍能启动（离线解密是本应用的卖点）。
const NETWORK_TIMEOUT_MS = 2500;
const NETWORK_FIRST = new Set([
  '',                 // scope 根，即 index.html
  'index.html',
  'flutter_bootstrap.js',
  'flutter.js',
  'main.dart.js',
  'manifest.json',
  'decrypt_worker.js',
  // 资源清单决定字体/图片的真实路径，和 main.dart.js 必须同代，
  // 否则会出现「新引擎 + 旧清单」的错位。
  'assets/AssetManifest.bin',
  'assets/AssetManifest.bin.json',
  'assets/FontManifest.json',
  // CanvasKit 同样是无哈希文件名；版本必须和 main.dart.js 对齐，
  // 否则升级 Flutter 后首屏可能白屏。
  'canvaskit/canvaskit.js',
  'canvaskit/canvaskit.wasm',
  'canvaskit/chromium/canvaskit.js',
  'canvaskit/chromium/canvaskit.wasm'
]);

// 两套 CanvasKit 都缓存（约 12.8MB）：Chromium 走 chromium/ 变体，
// Safari / Firefox 走通用版。
// 但只预缓存「本浏览器真会用到」的那一套：两套加起来约 13MB，首访时在后台
// 跟 main.dart.js、字体抢带宽，国内访问 GitHub Pages 会明显拖慢首屏。
// 另一套在换浏览器访问时会按需下载并顺手缓存（fetch 处理器会写缓存），
// 所以离线能力不受影响。
const IS_BLINK = navigator.vendor === 'Google Inc.' ||
  /(?:Edg|OPR|Chrome)\//.test(navigator.userAgent);
const CANVASKIT_VARIANT = IS_BLINK
  ? ['canvaskit/chromium/canvaskit.js', 'canvaskit/chromium/canvaskit.wasm']
  : ['canvaskit/canvaskit.js', 'canvaskit/canvaskit.wasm'];

const PRECACHE = [
  '', // scope 根，即 index.html
  'index.html',
  'flutter_bootstrap.js',
  'flutter.js',
  'main.dart.js',
  'manifest.json',
  'favicon.png',
  'decrypt_worker.js',
  'fflate.min.js',
  'crypto-js.min.js',
  ...CANVASKIT_VARIANT,
  'icons/Icon-192.png',
  'icons/Icon-512.png',
  'icons/Icon-maskable-192.png',
  'icons/Icon-maskable-512.png',
  'assets/AssetManifest.bin',
  'assets/AssetManifest.bin.json',
  'assets/FontManifest.json',
  'assets/fonts/MaterialIcons-Regular.otf',
  // MiSans 子集（ASCII + 界面文案，两个字重合计约 560KB）
  'assets/assets/fonts/MiSans-Regular.ttf',
  'assets/assets/fonts/MiSans-Bold.ttf',
  // 首屏 MiSans 子集分片（400/700 两字重，合计约 43KB）+ 引擎兜底 Roboto 的本地镜像
  'fonts/misans-firstscreen.woff2',
  'fonts/misans-firstscreen-bold.woff2',
  'fonts/fallback/roboto/v32/KFOmCnqEu92Fr1Me4GZLCzYlKw.woff2',
  'assets/fonts/fallback/Roboto-Regular.ttf',
  'assets/packages/cupertino_icons/assets/CupertinoIcons.ttf',
  'assets/shaders/ink_sparkle.frag',
  'assets/shaders/stretch_effect.frag',
  'assets/assets/tray_icon.ico',
  'assets/assets/tray_icon_mac.png'
];

// 去掉 scope 前缀，得到 PRECACHE 里那种相对路径；不在 scope 内返回 null。
function relPath(url) {
  if (!url.pathname.startsWith(SCOPE_PATH)) return null;
  return url.pathname.slice(SCOPE_PATH.length);
}

function isOffline() {
  try {
    return self.navigator && self.navigator.onLine === false;
  } catch (e) {
    return false;
  }
}

// 导航请求统一落到 index.html 这个 key 上：地址栏可能带 ?query 或尾部斜杠差异，
// 用原始 request 当 key 会缓存出一堆重复条目。
function isNavigation(request) {
  return request.mode === 'navigate';
}

function cacheKeyFor(request, rel) {
  if (isNavigation(request)) return new Request(asset('index.html'));
  if (rel) return new Request(asset(rel));
  return new Request(request.url);
}

function lookup(cache, request) {
  const key = isNavigation(request) ? asset('index.html') : request;
  return cache.match(key, { ignoreSearch: true });
}

function store(event, cache, request, response, rel) {
  if (!response || !response.ok || response.type !== 'basic') return;
  let key;
  try {
    key = cacheKeyFor(request, rel);
  } catch (e) {
    return;
  }
  const put = cache.put(key, response.clone()).catch(() => {});
  try {
    event.waitUntil(put);
  } catch (e) {
    // respondWith 已经 settle，waitUntil 会抛；放后台跑就行
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function offlineFallback(cache, request) {
  if (isNavigation(request)) {
    const shell = await cache.match(asset('index.html'));
    if (shell) return shell;
  }
  return Response.error();
}

// 入口文件：网络优先，超时或断网回落缓存（保证离线仍可启动）。
async function networkFirst(event, request, cache, rel) {
  const cached = await lookup(cache, request);
  if (isOffline() && cached) return cached;

  const network = fetch(request, { cache: 'no-cache' }).then((response) => {
    store(event, cache, request, response, rel);
    return response;
  });
  // 超时后这条链会被丢弃，但缓存仍会补上，下次就是新的了。
  network.catch(() => {});

  if (!cached) {
    try {
      return await network;
    } catch (e) {
      return offlineFallback(cache, request);
    }
  }

  try {
    return await Promise.race([
      network,
      delay(NETWORK_TIMEOUT_MS).then(() => {
        throw new Error('network timeout');
      })
    ]);
  } catch (e) {
    return cached;
  }
}

// 其余静态资源：缓存优先 + 后台更新（下一次访问即最新）。
async function cacheFirst(event, request, cache, rel) {
  const cached = await lookup(cache, request);
  const network = fetch(request).then((response) => {
    store(event, cache, request, response, rel);
    return response;
  });
  network.catch(() => {});

  if (cached) return cached;
  try {
    return await network;
  } catch (e) {
    return offlineFallback(cache, request);
  }
}

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
        // cache: 'reload' 绕过 HTTP 缓存，确保装进来的是线上最新版本
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

  const rel = relPath(url);

  event.respondWith((async () => {
    // version.json 永不进缓存：它是判断「线上有没有新版本」的唯一依据，
    // 一旦被缓存就再也看不出新旧了。
    if (rel === 'version.json') {
      try {
        return await fetch(request, { cache: 'no-store' });
      } catch (e) {
        return new Response('{}', {
          headers: { 'content-type': 'application/json' }
        });
      }
    }

    const cache = await caches.open(CACHE_NAME);
    if (rel !== null && NETWORK_FIRST.has(rel)) {
      return networkFirst(event, request, cache, rel);
    }
    return cacheFirst(event, request, cache, rel);
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
