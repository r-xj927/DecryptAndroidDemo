// web/decrypt_worker.js
// 后台 Web Worker：在独立线程中完成 ZIP 解压（fflate）与原生 JS AES 解密（crypto-js）。
// 这样即使解密 140MB 大文件，主线程也完全不会被阻塞。
importScripts('fflate.min.js', 'crypto-js.min.js');

// 保存解压后的全部文件，跨消息复用（init 解出后，key 消息中直接消费）
var gFiles = null;

self.onmessage = function (ev) {
  var msg = ev.data;

  // ---- 第一步：解压并回传 info 文本（供 Dart 端用私钥做 RSA 解密出密钥）----
  if (msg.type === 'init') {
    try {
      var zipBytes = new Uint8Array(msg.zip);
      gFiles = fflate.unzipSync(zipBytes); // { 文件名: Uint8Array }
      var infoBytes = gFiles['info'];
      if (!infoBytes) {
        self.postMessage({ type: 'error', message: 'ZIP 中没有找到 info 文件，这可能不是本工具加密的日志包。' });
        return;
      }
      var infoText = new TextDecoder('utf-8').decode(infoBytes);
      self.postMessage({ type: 'info', text: infoText });
    } catch (e) {
      self.postMessage({ type: 'error', message: 'ZIP 解压失败：' + (e && e.message ? e.message : e) });
    }
    return;
  }

  // ---- 第二步：拿到密钥后逐文件逐行解密 ----
  if (msg.type === 'key') {
    if (!gFiles) {
      self.postMessage({ type: 'error', message: '未收到压缩包数据。' });
      return;
    }
    try {
      var key = CryptoJS.enc.Hex.parse(msg.aesKeyHex);
      var iv = CryptoJS.enc.Hex.parse('00000000000000000000000000000000');
      var isCbc = msg.encodeWay === 'AES/CBC/PKCS7Padding';
      var mode = isCbc ? CryptoJS.mode.CBC : CryptoJS.mode.ECB;
      var padding = CryptoJS.pad.Pkcs7;

      var names = Object.keys(gFiles);
      var total = names.length; // info 也参与解密与进度
      var done = 0;
      var result = [];

      for (var i = 0; i < names.length; i++) {
        var name = names[i];
        var contentBytes = gFiles[name];
        var text = new TextDecoder('utf-8').decode(contentBytes);
        var lines = text.split('\n');
        // 复刻 Dart 端 _splitLinesBytes：丢弃文件末尾的换行产生的空段
        if (lines.length > 0 && lines[lines.length - 1] === '') {
          lines.pop();
        }
        var parts = [];

        if (name === 'info') {
          // info 前 2 行为 RSA 加密的密钥与模式（Dart 端已用私钥解密出密钥），
          // 其余行为 AES 加密的日志内容，用解密出的密钥逐行解密。
          var body = lines.slice(2);
          for (var j = 0; j < body.length; j++) {
            var line = body[j];
            if (line.length === 0) {
              parts.push('\n');
              continue;
            }
            try {
              var ct = CryptoJS.enc.Base64.parse(line.trim());
              var d = CryptoJS.AES.decrypt(
                { ciphertext: ct },
                key,
                { mode: mode, padding: padding, iv: iv }
              );
              parts.push(d.toString(CryptoJS.enc.Utf8));
            } catch (e2) {
              // 解密失败则保留原始 base64 文本（与原逻辑一致）
              parts.push(line);
            }
            parts.push('\n');
          }
        } else {
          for (var j = 0; j < lines.length; j++) {
            var line = lines[j];
            if (line.length === 0) {
              parts.push('\n');
              continue;
            }
            try {
              var ct = CryptoJS.enc.Base64.parse(line.trim());
              var d = CryptoJS.AES.decrypt(
                { ciphertext: ct },
                key,
                { mode: mode, padding: padding, iv: iv }
              );
              parts.push(d.toString(CryptoJS.enc.Utf8));
            } catch (e2) {
              // 解密失败则保留原始 base64 文本（与原逻辑一致）
              parts.push(line);
            }
            parts.push('\n');
          }
        }

        var out = parts.join('');
        // 复刻 Dart 端：最后一行后不补 '\n'
        if (out.length > 0 && out[out.length - 1] === '\n') {
          out = out.substring(0, out.length - 1);
        }
        result.push({ name: name, content: out, size: out.length });
        done++;
        self.postMessage({ type: 'progress', done: done, total: total });
      }

      gFiles = null; // 释放内存
      self.postMessage({ type: 'done', files: result });
    } catch (e) {
      self.postMessage({ type: 'error', message: '解密失败：' + (e && e.message ? e.message : e) });
    }
    return;
  }
};
