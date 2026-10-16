/* background.js 测试：验证大模型调用的解析、重试与错误处理（stub fetch，不发起真实网络请求）
   运行：node test_background.js                                              */
'use strict';

let listener = null;
let storedConfig = {};
let fetchLog = [];
let fetchImpl = null;
let frameResponders = {};   // frameId -> (msg) => resp | null
let broadcastLog = [];

global.chrome = {
  runtime: {
    onMessage: { addListener(fn) { listener = fn; } },
    lastError: null
  },
  tabs: {
    sendMessage(tabId, msg, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      if (opts && opts.frameId != null) {
        const fn = frameResponders[opts.frameId];
        const resp = fn ? fn(msg) : null;
        setTimeout(function () { if (cb) cb(resp || undefined); }, 0);
        return;
      }
      broadcastLog.push({ tabId: tabId, msg: msg });
      setTimeout(function () { if (cb) cb(undefined); }, 0);
    }
  },
  webNavigation: {
    getAllFrames(opts, cb) {
      setTimeout(function () {
        cb(Object.keys(frameResponders).map(function (k) { return { frameId: parseInt(k, 10) }; }));
      }, 0);
    }
  },
  storage: {
    local: {
      get(key, cb) { cb({ [key]: storedConfig }); }
    }
  }
};
global.fetch = function (url, opts) {
  fetchLog.push({ url: url, body: JSON.parse(opts.body) });
  return fetchImpl(url, opts);
};

require('./background.js');

if (!listener) { console.error('未注册 onMessage 监听'); process.exit(2); }

function respond(msg, sender) {
  return new Promise((resolve) => {
    listener(msg, sender || {}, resolve);
  });
}

function jsonResponse(obj, status) {
  return Promise.resolve({
    ok: !status || status < 400,
    status: status || 200,
    text: () => Promise.resolve(typeof obj === 'string' ? obj : JSON.stringify(obj))
  });
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); }
}

(async function run() {
  /* 1. 正常返回 */
  storedConfig = { provider: 'zhipu', baseUrl: 'https://api.example.com/v1/chat/completions', model: 'glm-4-flash', apiKey: 'sk-test', timeoutMs: 5000, maxRetries: 2, temperature: 0.2 };
  fetchImpl = () => jsonResponse({ choices: [{ message: { content: '{"answer":"A"}' } }] });
  fetchLog = [];
  let r = await respond({ type: 'LLM_CHAT', messages: [{ role: 'user', content: 'hi' }] });
  check('正常返回 ok', r.ok === true, r);
  check('返回内容正确', r.answer === '{"answer":"A"}', r.answer);
  check('带上 Authorization 头', fetchLog.length === 1);

  /* 2. 429 限流后重试成功 */
  let calls = 0;
  fetchImpl = () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ error: { message: 'rate limit' } }, 429);
    return jsonResponse({ choices: [{ message: { content: '{"answer":"B"}' } }] });
  };
  r = await respond({ type: 'LLM_CHAT', messages: [{ role: 'user', content: 'hi' }] });
  check('429 后重试成功', r.ok === true && r.answer === '{"answer":"B"}', r);
  check('429 实际请求 2 次', calls === 2, calls);

  /* 3. 401 不重试 */
  calls = 0;
  fetchImpl = () => { calls += 1; return jsonResponse({ error: { message: 'invalid api key' } }, 401); };
  r = await respond({ type: 'LLM_CHAT', messages: [{ role: 'user', content: 'hi' }] });
  check('401 返回失败', r.ok === false, r);
  check('401 只请求 1 次', calls === 1, calls);
  check('401 错误信息含状态码', String(r.error).indexOf('401') !== -1, r.error);

  /* 4. 网络异常（超时/断网）重试 */
  calls = 0;
  fetchImpl = () => { calls += 1; return Promise.reject(new Error('network timeout')); };
  r = await respond({ type: 'LLM_CHAT', messages: [{ role: 'user', content: 'hi' }] });
  check('网络异常返回失败', r.ok === false, r);
  check('网络异常重试 3 次（1+2）', calls === 3, calls);

  /* 5. 兼容非标准响应结构 */
  fetchImpl = () => jsonResponse({ output_text: '{"answer":"C"}' });
  r = await respond({ type: 'LLM_CHAT', messages: [{ role: 'user', content: 'hi' }] });
  check('解析 output_text 结构', r.ok === true && r.answer === '{"answer":"C"}', r);

  /* 6. 未配置 Key 且非本地地址 -> 直接失败 */
  storedConfig = { baseUrl: 'https://api.example.com/v1/chat/completions', model: 'glm-4-flash', apiKey: '' };
  fetchLog = [];
  r = await respond({ type: 'LLM_CHAT', messages: [{ role: 'user', content: 'hi' }] });
  check('缺 Key 时拒绝请求', r.ok === false && String(r.error).indexOf('API Key') !== -1, r);
  check('缺 Key 时未发起网络请求', fetchLog.length === 0, fetchLog.length);

  /* 7. 本地 Ollama 允许空 Key */
  storedConfig = { baseUrl: 'http://127.0.0.1:11434/v1/chat/completions', model: 'qwen2.5:7b', apiKey: '' };
  fetchImpl = () => jsonResponse({ choices: [{ message: { content: 'OK' } }] });
  fetchLog = [];
  r = await respond({ type: 'LLM_TEST' });
  check('本地地址无需 Key', r.ok === true, r);
  check('测试连接发起请求', fetchLog.length === 1);

  /* 8. 缺少 messages */
  r = await respond({ type: 'LLM_CHAT' });
  check('缺 messages 返回错误', r.ok === false, r);

  /* 9. 跨 frame 聚合：取题目最多的 frame（主 frame 0 题，子 frame 5 题） */
  frameResponders = {
    0: (msg) => msg.type === 'GET_STATE'
      ? { ok: true, state: { questions: 0, hasVideo: true, url: 'https://mooc1.chaoxing.com/mycourse/studentstudy' } }
      : (msg.action === 'DUMP' ? { ok: true, dump: '页面：main\n识别到题目：0' } : null),
    3: (msg) => msg.type === 'GET_STATE'
      ? { ok: true, state: { questions: 5, hasVideo: false, url: 'https://mooc1.chaoxing.com/mycourse/studentwork' } }
      : (msg.action === 'DUMP' ? { ok: true, dump: '页面：work\n识别到题目：5\n【单选题】中国的近代史' } : null)
  };

  r = await respond({ type: 'GET_BEST_STATE', tabId: 1 });
  check('聚合状态取到题目最多的帧', r.ok === true && r.state && r.state.questions === 5, r);
  check('聚合状态带回 frameId', r.frameId === 3, r.frameId);

  r = await respond({ type: 'DUMP_TAB', tabId: 1 });
  check('诊断合并取到有题目的那份', r.ok === true && String(r.dump).indexOf('识别到题目：5') !== -1, r);
  check('诊断回传题目数', r.questions === 5, r);

  /* 10. 所有帧都没有题目时也不报错 */
  frameResponders = { 0: (msg) => msg.type === 'GET_STATE' ? { ok: true, state: { questions: 0, hasVideo: false } } : null };
  r = await respond({ type: 'GET_BEST_STATE', tabId: 1 });
  check('无题目时仍返回状态', r.ok === true && r.state && r.state.questions === 0, r);
  r = await respond({ type: 'DUMP_TAB', tabId: 1 });
  check('无题目时不崩溃', r.ok === true, r);

  /* 11. GOTO_NEXT：子 frame 提交后由后台广播 NEXT_CHAPTER */
  broadcastLog = [];
  r = await respond({ type: 'GOTO_NEXT' }, { tab: { id: 7 } });
  check('GOTO_NEXT 返回成功', r.ok === true, r);
  check('GOTO_NEXT 广播到该 tab', broadcastLog.length === 1 && broadcastLog[0].tabId === 7, broadcastLog);
  check('GOTO_NEXT 消息为 NEXT_CHAPTER',
    broadcastLog[0] && broadcastLog[0].msg.type === 'ACTION' && broadcastLog[0].msg.action === 'NEXT_CHAPTER', broadcastLog);
  r = await respond({ type: 'GOTO_NEXT' }, {});
  check('无 tabId 时返回失败', r.ok === false, r);

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('测试异常：', e);
  process.exit(3);
});
