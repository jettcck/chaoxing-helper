'use strict';

/* ================= 大模型调用（后台代理，避免页面 CSP 限制） ================= */

var CFG_KEY = 'cx_llm';

/* 按 tab + frame 聚合内容脚本上报的状态，用于定位"有题目的那个 frame" */
var tabFrames = {};
var FRAME_TTL = 15000;

function handleFrameState(sender, st) {
  var tabId = sender && sender.tab && sender.tab.id;
  if (tabId == null || !st) return;
  var frameId = sender.frameId == null ? 0 : sender.frameId;
  tabFrames[tabId] = tabFrames[tabId] || {};
  tabFrames[tabId][frameId] = { state: st, ts: Date.now() };
}

function bestFrame(tabId) {
  var m = tabFrames[tabId] || {};
  var best = null;
  Object.keys(m).forEach(function (k) {
    var e = m[k];
    if (Date.now() - e.ts > FRAME_TTL) return;
    var score = (e.state.questions || 0) * 100 + (e.state.hasVideo ? 10 : 0);
    if (!best || score > best.score) {
      best = { frameId: parseInt(k, 10), state: e.state, score: score };
    }
  });
  return best;
}

/** 向 tab 内所有 frame 广播并收集全部响应（chrome.tabs.sendMessage 单响应拿不全） */
function collectFromFrames(tabId, message, maxFrames) {
  return new Promise(function (resolve) {
    var finished = false;
    function finish(list) {
      if (finished) return;
      finished = true;
      resolve(list);
    }

    function askAll(ids) {
      var results = [];
      var pending = ids.length;
      if (!pending) { finish(results); return; }
      ids.forEach(function (fid) {
        try {
          chrome.tabs.sendMessage(tabId, message, { frameId: fid }, function (resp) {
            if (!chrome.runtime.lastError && resp) results.push({ frameId: fid, resp: resp });
            pending -= 1;
            if (pending === 0) finish(results);
          });
        } catch (e) {
          pending -= 1;
          if (pending === 0) finish(results);
        }
      });
      setTimeout(function () { finish(results); }, 2500);
    }

    function fallbackIds() {
      var ids = [];
      for (var i = 0; i < (maxFrames || 8); i++) ids.push(i);
      return ids;
    }

    if (chrome.webNavigation && chrome.webNavigation.getAllFrames) {
      try {
        chrome.webNavigation.getAllFrames({ tabId: tabId }, function (frames) {
          if (chrome.runtime.lastError || !frames || !frames.length) {
            askAll(fallbackIds());
            return;
          }
          askAll(frames.map(function (f) { return f.frameId; }));
        });
      } catch (e) {
        askAll(fallbackIds());
      }
    } else {
      askAll(fallbackIds());
    }
  });
}

function scoreOfState(st) {
  if (!st) return -1;
  return (st.questions || 0) * 100 + (st.hasVideo ? 10 : 0);
}

function scoreOfDump(text) {
  if (!text) return -1;
  var m = String(text).match(/识别到题目：(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

var DEFAULTS = {
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  apiKey: '',
  model: 'glm-4-flash',
  timeoutMs: 30000,
  maxRetries: 2,
  temperature: 0.2
};

function getConfig() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(CFG_KEY, function (data) {
      resolve(Object.assign({}, DEFAULTS, (data && data[CFG_KEY]) || {}));
    });
  });
}

function isLocal(url) {
  return /localhost|127\.0\.0\.1|\[::1\]/.test(url || '');
}

function extractContent(data) {
  if (!data) return '';
  if (data.choices && data.choices.length) {
    var ch = data.choices[0];
    if (ch.message && typeof ch.message.content === 'string') return ch.message.content;
    if (ch.message && Array.isArray(ch.message.content)) {
      return ch.message.content.map(function (p) { return (p && p.text) || ''; }).join('');
    }
    if (typeof ch.text === 'string') return ch.text;
  }
  if (typeof data.output_text === 'string') return data.output_text;
  if (data.data && typeof data.data.answer === 'string') return data.data.answer;
  if (typeof data.result === 'string') return data.result;
  return '';
}

function chatOnce(cfg, messages, maxTokens) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, cfg.timeoutMs || 30000);
  var headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
  var body = {
    model: cfg.model,
    messages: messages,
    temperature: cfg.temperature == null ? 0.2 : cfg.temperature,
    max_tokens: maxTokens || 400,
    stream: false
  };
  return fetch(cfg.baseUrl, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body),
    signal: controller.signal
  }).then(function (res) {
    return res.text().then(function (text) {
      if (!res.ok) {
        var err = new Error('HTTP ' + res.status + '：' + String(text).slice(0, 200));
        err.status = res.status;
        throw err;
      }
      var data = JSON.parse(text);
      var content = extractContent(data);
      if (!content) throw new Error('响应中没有可用内容：' + String(text).slice(0, 120));
      return content;
    });
  }).finally(function () { clearTimeout(timer); });
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function chat(cfg, messages, maxTokens) {
  var max = cfg.maxRetries == null ? 2 : parseInt(cfg.maxRetries, 10) || 0;
  var attempt = 0;
  var lastErr = null;

  function run() {
    return chatOnce(cfg, messages, maxTokens).then(function (content) {
      return { ok: true, answer: content, model: cfg.model };
    }).catch(function (e) {
      lastErr = e;
      var status = e && e.status;
      // 鉴权、参数类错误不重试；429 与网络/超时可退避重试
      if (status && status >= 400 && status < 500 && status !== 429) {
        return { ok: false, error: (e && e.message) || '请求失败', status: status };
      }
      attempt += 1;
      if (attempt > max) return { ok: false, error: (lastErr && lastErr.message) || '请求失败' };
      return sleep(800 * attempt).then(run);
    });
  }

  return run();
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  if (msg.type === 'FRAME_STATE') {
    handleFrameState(sender, msg.state);
    sendResponse({ ok: true });
    return;
  }

  /* 子 frame 提交完测验后，通知同 tab 的其它 frame 去点"下一节"（目录树多在主 frame） */
  if (msg.type === 'GOTO_NEXT') {
    var gotoId = sender && sender.tab && sender.tab.id;
    if (gotoId == null) { sendResponse({ ok: false, error: '缺少 tabId' }); return; }
    try {
      chrome.tabs.sendMessage(gotoId, { type: 'ACTION', action: 'NEXT_CHAPTER' }, function () {
        void chrome.runtime.lastError;
      });
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
    return;
  }

  if (msg.type === 'GET_BEST_FRAME') {
    var tabId = msg.tabId != null ? msg.tabId : (sender && sender.tab && sender.tab.id);
    var best = tabId == null ? null : bestFrame(tabId);
    sendResponse({ ok: true, frameId: best ? best.frameId : null, state: best ? best.state : null });
    return;
  }

  /* 跨 frame 聚合状态：取"题目最多"的帧，避免读到没有题目的主 frame */
  if (msg.type === 'GET_BEST_STATE') {
    var tid = msg.tabId != null ? msg.tabId : (sender && sender.tab && sender.tab.id);
    if (tid == null) { sendResponse({ ok: false, error: '缺少 tabId' }); return; }
    collectFromFrames(tid, { type: 'GET_STATE' }, 24).then(function (list) {
      var bestState = null;
      var bestScore = -1;
      var bestFid = null;
      list.forEach(function (item) {
        var st = item.resp && item.resp.state;
        var sc = scoreOfState(st);
        if (sc > bestScore) { bestScore = sc; bestState = st; bestFid = item.frameId; }
      });
      if (!bestState && tabFrames[tid]) {
        var known = bestFrame(tid);
        if (known) { bestState = known.state; bestFid = known.frameId; }
      }
      sendResponse({ ok: true, state: bestState, frameId: bestFid, frames: list.length });
    });
    return true;
  }

  /* 跨 frame 收集诊断信息，返回题目最多的那份 */
  if (msg.type === 'DUMP_TAB') {
    var tid2 = msg.tabId != null ? msg.tabId : (sender && sender.tab && sender.tab.id);
    if (tid2 == null) { sendResponse({ ok: false, error: '缺少 tabId' }); return; }
    collectFromFrames(tid2, { type: 'ACTION', action: 'DUMP' }, 24).then(function (list) {
      var bestDump = null;
      var bestScore = -1;
      list.forEach(function (item) {
        var d = item.resp && item.resp.dump;
        var sc = scoreOfDump(d);
        if (sc > bestScore) { bestScore = sc; bestDump = d; }
      });
      sendResponse({
        ok: true,
        dump: bestDump,
        frames: list.length,
        questions: bestScore < 0 ? 0 : bestScore
      });
    });
    return true;
  }

  if (msg.type === 'LLM_CHAT') {
    if (!msg.messages) { sendResponse({ ok: false, error: '缺少 messages' }); return; }
    getConfig().then(function (cfg) {
      if (!cfg.baseUrl) return { ok: false, error: '未配置接口地址' };
      if (!cfg.apiKey && !isLocal(cfg.baseUrl)) return { ok: false, error: '未配置 API Key' };
      return chat(cfg, msg.messages, msg.maxTokens);
    }).then(function (r) {
      sendResponse(r || { ok: false, error: '未知错误' });
    }).catch(function (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    });
    return true;
  }

  if (msg.type === 'LLM_TEST') {
    getConfig().then(function (cfg) {
      if (!cfg.baseUrl) return { ok: false, error: '未配置接口地址' };
      if (!cfg.apiKey && !isLocal(cfg.baseUrl)) return { ok: false, error: '未配置 API Key' };
      return chat(cfg, [{ role: 'user', content: '只回复两个字符：OK' }], 16);
    }).then(function (r) {
      sendResponse(r || { ok: false, error: '未知错误' });
    }).catch(function (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    });
    return true;
  }
});
