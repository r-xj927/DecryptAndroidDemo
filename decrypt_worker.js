// web/decrypt_worker.js
// 后台 Web Worker：流式读取 ZIP + 流式解压 + 逐行 AES 解密。
//
// 目标：iOS Safari 的 WebContent 进程内存预算很低（约 100–200MB），
// 绝不能把「整包字节 + 全量解压内容 + 全量行数组 + 全量明文」同时放在内存里。
// 因此这里：
//   1. 直接接收 html.File（结构化克隆，不进 Dart 堆）；
//   2. File.stream()/slice 分块读取；
//   3. fflate.Unzip 流式解压（每收到一块就喂进去）；
//   4. 边解码边按 '\n' 切行，逐行 CryptoJS AES 解密；
//   5. 每个文件只回传 Blob objectURL + 前 2000 字预览，不回传全量正文。
//
// 关键顺序约束：info 的前两行要先解出 AES 密钥，之后才能解密任何正文。
// fflate 一次 push 可能同时解出 info 与后续条目，所以所有条目的明文片段
// 在 gHaveKey 之前先排队，等 Dart 回传 key 后再统一解密。
importScripts('fflate.min.js', 'crypto-js.min.js');

var gFile = null;
var gStreamReader = null;
var gOffset = 0;
var gTotalBytes = 0;
var gBytesRead = 0;
var gUnzip = null;

var gNeedKey = false;
var gHaveKey = false;
var gPumpActive = false;
var gHeaderLines = [];
var gDoneFiles = 0;
var gDoneEntries = 0;
var gTotalEntries = 0;
var gPendingHandlers = [];
var gLastProgressAt = 0;
var PROGRESS_INTERVAL_MS = 150;

var gKey = null;
var gIv = null;
var gMode = null;
var gPadding = CryptoJS.pad.Pkcs7;

var CHUNK_SIZE = 1024 * 1024;
// 与 log_viewer.dart 的 _maxLines 对齐：查看器最多索引 20 万行。
var PREVIEW_LINES = 200000;
var FLUSH_THRESHOLD = 256 * 1024;

function errText(e) {
  return e && e.message ? e.message : String(e);
}

function postError(prefix, e) {
  self.postMessage({ type: 'error', message: prefix + errText(e) });
}

// 分块读取 File：优先 ReadableStream，老 Safari 回退到 slice().arrayBuffer()
function readNext() {
  if (gStreamReader) return gStreamReader.read();
  if (gOffset >= gTotalBytes) {
    return Promise.resolve({ done: true, value: undefined });
  }
  var end = Math.min(gOffset + CHUNK_SIZE, gTotalBytes);
  var start = gOffset;
  gOffset = end;
  return gFile.slice(start, end).arrayBuffer().then(function (buf) {
    return { done: false, value: new Uint8Array(buf) };
  });
}

// 从 ZIP 末尾的 EOCD 读出条目总数，给「已解密 N/总数 个文件」提供准确分母。
// 只读最后约 64KB，不把整包读进内存；解析失败时返回 0，界面退化为「已完成 N 个文件」。
function readZipEntryCount(file) {
  return new Promise(function (resolve) {
    var tailSize = Math.min(file.size || 0, 66000);
    if (tailSize < 22) {
      resolve(0);
      return;
    }
    file.slice(file.size - tailSize, file.size).arrayBuffer().then(function (buf) {
      try {
        var view = new DataView(buf);
        for (var i = view.byteLength - 22; i >= 0; i--) {
          if (view.getUint32(i, true) === 0x06054b50) {
            resolve(view.getUint16(i + 10, true) || 0);
            return;
          }
        }
      } catch (_) {
        // ignore
      }
      resolve(0);
    }).catch(function () {
      resolve(0);
    });
  });
}

function postFilesProgress() {
  self.postMessage({
    type: 'progress',
    stage: 'files',
    done: gDoneEntries,
    total: gTotalEntries
  });
}

function pump() {
  if (gPumpActive) return;
  gPumpActive = true;

  (async function () {
    try {
      while (true) {
        var r = await readNext();
        if (r.done) {
          gUnzip.push(new Uint8Array(0), true);
          // 给 entry.ondata(final) 的回调留出执行机会再宣告完成。
          setTimeout(function () {
            if (!gHaveKey) {
              postError('解压完成了但没有找到 info 密钥信息，这可能不是本工具加密的日志包。', new Error('missing info'));
            } else {
              self.postMessage({ type: 'done' });
            }
          }, 0);
          break;
        }

        gBytesRead += r.value.byteLength;
        self.postMessage({
          type: 'progress',
          stage: 'bytes',
          done: gBytesRead,
          total: gTotalBytes
        });

        gUnzip.push(r.value, false);

        // 解出 info 的前两行后暂停读取，等 Dart 用私钥解出 AES 密钥。
        // 同一块里已经解出的正文会暂存在 gPendingHandlers 里，不会提前解密。
        if (gNeedKey && !gHaveKey) break;
      }
    } catch (e) {
      postError('读取或解压压缩包失败：', e);
    } finally {
      gPumpActive = false;
    }
  })();
}

// 为一个 ZIP 条目创建流式 ondata 处理器。
function makeEntryHandler(name) {
  var decoder = new TextDecoder('utf-8');
  var isInfo = name === 'info';
  var headerDone = !isInfo;
  var headerCarry = '';

  var carry = '';
  var parts = [];
  var partsLen = 0;
  var blobs = [];
  var preview = '';
  var previewLines = 0;
  var previewTruncated = false;
  var finalized = false;
  var pendingFinal = false;
  var waiting = [];
  // 只统计“当前这个文件”已解密的行数，切到下一个文件时自然从 0 开始。
  var linesDone = 0;

  var api = {};

  function pushPiece(s) {
    if (!s) return;
    parts.push(s);
    partsLen += s.length;
    // 预览按“行数”截断，和查看器的 20 万行索引上限一致。
    if (previewLines < PREVIEW_LINES) {
      var cut = s.length;
      var count = previewLines;
      var idx = 0;
      while (count < PREVIEW_LINES && (idx = s.indexOf('\n', idx)) >= 0) {
        count++;
        idx++;
        if (count === PREVIEW_LINES) {
          cut = idx;
          break;
        }
      }
      previewLines = count;
      preview += s.slice(0, cut);
      if (cut < s.length) previewTruncated = true;
    } else if (s.length) {
      previewTruncated = true;
    }
    // 攒够一批就转成 Blob 分片，避免明文字符串无限增长。
    if (partsLen >= FLUSH_THRESHOLD && parts.length > 1) {
      var keep = parts.pop();
      blobs.push(new Blob(parts, { type: 'text/plain;charset=utf-8' }));
      parts = [keep];
      partsLen = keep.length;
    }
  }

  function noteLineDecrypted() {
    linesDone++;
    var now = Date.now();
    if (now - gLastProgressAt >= PROGRESS_INTERVAL_MS) {
      gLastProgressAt = now;
      self.postMessage({
        type: 'progress',
        stage: 'lines',
        done: linesDone,
        total: 0,
        name: name,
        files: gDoneEntries,
        fileTotal: gTotalEntries
      });
    }
  }

  function decryptLine(line) {
    if (line.length === 0) {
      pushPiece('\n');
      noteLineDecrypted();
      return;
    }
    var out = line;
    try {
      var ct = CryptoJS.enc.Base64.parse(line.trim());
      var d = CryptoJS.AES.decrypt(
        { ciphertext: ct },
        gKey,
        { mode: gMode, padding: gPadding, iv: gIv }
      );
      out = d.toString(CryptoJS.enc.Utf8);
    } catch (e) {
      // 与既有行为一致：坏行保留原始 base64 文本。
    }
    pushPiece(out);
    pushPiece('\n');
    noteLineDecrypted();
  }

  function feedText(text) {
    carry += text;
    var idx;
    while ((idx = carry.indexOf('\n')) >= 0) {
      var line = carry.slice(0, idx);
      carry = carry.slice(idx + 1);
      decryptLine(line);
    }
  }

  // 密钥没到之前只排队，绝不调用 decryptLine。
  function feedOrQueue(text) {
    if (!text) return;
    if (!gHaveKey) {
      waiting.push(text);
      return;
    }
    feedText(text);
  }

  function finishEntry() {
    if (finalized) return;
    finalized = true;

    var tail = decoder.decode();
    if (tail.length) {
      if (headerDone) feedText(tail);
      else headerCarry += tail;
    }
    if (!headerDone) {
      postError('info 文件格式不正确：', '缺少两行密钥信息');
      return;
    }
    // 文件末尾没有换行的那一行也要解密；有换行时不额外补 '\n'。
    if (carry.length) decryptLine(carry);
    // 复刻旧逻辑：结果末尾不保留换行。
    if (parts.length && parts[parts.length - 1].slice(-1) === '\n') {
      var last = parts[parts.length - 1].slice(0, -1);
      if (last.length) parts[parts.length - 1] = last;
      else parts.pop();
    }

    // Blob 拼接与 objectURL 生成也可能占一段时间，先给主线程一个明确阶段。
    self.postMessage({
      type: 'progress',
      stage: 'finalizing',
      done: gDoneFiles + 1,
      total: 0,
      name: name
    });

    if (parts.length) {
      blobs.push(new Blob(parts, { type: 'text/plain;charset=utf-8' }));
    }
    var blob = new Blob(blobs, { type: 'text/plain;charset=utf-8' });
    // 千万不要在这里 URL.createObjectURL(blob)。
    // WebKit（iOS Safari）把 blob URL 登记在「创建它的执行上下文」里，
    // Worker 里造的 blob: 链接在主线程解析不到，点下载就是死链（下载失败/白屏）。
    // 直接把 Blob 发回主线程：结构化克隆对 Blob 只传引用，不复制内容，
    // 内存开销和传 URL 一样小，由页面自己创建 objectURL。
    self.postMessage({
      type: 'fileDone',
      name: name,
      size: blob.size,
      blob: blob,
      preview: preview,
      isPreview: previewTruncated
    });

    gDoneFiles++;
    gDoneEntries++;
    postFilesProgress();

    blobs = null;
    parts = null;
    waiting = null;
  }

  // Dart 回传密钥后调用：把排队文本 Feed 进解密，并完成此前已到 final 的条目。
  api.flush = function () {
    if (finalized) return;
    if (waiting && waiting.length) {
      var text = waiting.join('');
      waiting = [];
      feedText(text);
    }
    if (pendingFinal) {
      pendingFinal = false;
      finishEntry();
    }
  };

  api.ondata = function (err, chunk, final) {
    if (finalized) return;
    if (err) {
      finalized = true;
      postError('解压 ' + name + ' 失败：', err);
      return;
    }

    if (chunk && chunk.length) {
      var text = decoder.decode(chunk, { stream: true });

      if (!headerDone) {
        // info 前两行是 RSA 加密的 AES 密钥与模式，只取这两行，
        // 正文继续走正常解密流程。
        headerCarry += text;
        var nl;
        while (!headerDone && (nl = headerCarry.indexOf('\n')) >= 0) {
          var line = headerCarry.slice(0, nl);
          headerCarry = headerCarry.slice(nl + 1);
          gHeaderLines.push(line);
          if (gHeaderLines.length === 2) {
            headerDone = true;
            gNeedKey = true;
            self.postMessage({ type: 'info', text: gHeaderLines.join('\n') });
          }
        }
        if (headerDone && headerCarry.length) {
          feedOrQueue(headerCarry);
          headerCarry = '';
        }
      } else {
        feedOrQueue(text);
      }
    }

    if (!final) return;
    if (!gHaveKey) {
      // 同一块里可能已经把这个条目解完了，先记住 final，等密钥到了再收尾。
      pendingFinal = true;
      return;
    }
    finishEntry();
  };

  return api;
}

self.onmessage = function (ev) {
  var msg = ev.data || {};

  if (msg.type === 'init') {
    var file = msg.file;
    if (!file) {
      self.postMessage({ type: 'error', message: '没有收到文件对象，请重新选择文件。' });
      return;
    }
    gFile = file;
    gTotalBytes = file.size || 0;
    gBytesRead = 0;
    gOffset = 0;
    gHeaderLines = [];
    gDoneFiles = 0;
    gDoneEntries = 0;
    gTotalEntries = 0;
    gLastProgressAt = 0;
    gNeedKey = false;
    gHaveKey = false;
    gPendingHandlers = [];
    gKey = null;
    gIv = null;
    gMode = null;

    // 先读 ZIP 尾部目录拿总条目数，再开始流式解密。
    readZipEntryCount(file).then(function (count) {
      try {
        gTotalEntries = count || 0;

        if (typeof file.stream === 'function') {
          gStreamReader = file.stream().getReader();
        } else {
          gStreamReader = null;
        }

        gUnzip = new fflate.Unzip(function (entry) {
          var name = entry.name;
          if (!name || name.slice(-1) === '/') {
            entry.ondata = function () {};
            gDoneEntries++;
            postFilesProgress();
            entry.start();
            return;
          }
          var handler = makeEntryHandler(name);
          entry.ondata = handler.ondata;
          gPendingHandlers.push(handler);
          entry.start();
        });

        // fflate.Unzip 默认只支持 method 0（store）；常见 ZIP 用的是
        // method 8（deflate），必须显式注册这个流式解压器。
        gUnzip.register(fflate.UnzipInflate);

        pump();
      } catch (e) {
        postError('初始化解压失败：', e);
      }
    }).catch(function (e) {
      postError('读取 ZIP 目录失败：', e);
    });
    return;
  }

  if (msg.type === 'key') {
    try {
      gKey = CryptoJS.enc.Hex.parse(msg.aesKeyHex);
      gIv = CryptoJS.enc.Hex.parse('00000000000000000000000000000000');
      gMode = msg.encodeWay === 'AES/CBC/PKCS7Padding'
        ? CryptoJS.mode.CBC
        : CryptoJS.mode.ECB;
      gHaveKey = true;

      // 先把密钥到达前暂存的所有正文解密并收尾，再继续读后面的块。
      for (var i = 0; i < gPendingHandlers.length; i++) {
        gPendingHandlers[i].flush();
      }
      gPendingHandlers = [];

      pump();
    } catch (e) {
      postError('设置解密密钥失败：', e);
    }
    return;
  }
};
