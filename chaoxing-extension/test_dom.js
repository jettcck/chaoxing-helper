/* DOM 级测试：用 jsdom 搭建学习通作业/测验页结构，验证解析、点击选中、提交与答题全流程。
   运行：NODE_PATH=<workspace>/node_modules node test_dom.js            */
'use strict';

const { createRequire } = require('module');
let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (e) {
  try {
    const req = createRequire('C:/Users/王锦楠/.workbuddy/binaries/node/workspace/package.json');
    ({ JSDOM } = req('jsdom'));
  } catch (e2) {
    console.error('缺少 jsdom，请先在 node workspace 执行 npm install jsdom');
    console.error('详细：', e2.message);
    process.exit(2);
  }
}

/* ---------- 学习通作业页结构（按真实 DOM 简化还原） ---------- */
const FIXTURE = `<!DOCTYPE html><html><body>
<div class="TiMu" id="q1">
  <div class="Zy_TItle clearfix">
    <div class="fl"><i>1</i>【单选题】中国的近代史，是指（ ）以来的中国的历史。</div>
    <div class="fr">(分值：20.0分)</div>
  </div>
  <ul class="Zy_ulTop">
    <li data="A"><a href="javascript:void(0);"><i class="fl">A</i><div class="fl">1840年</div></a><input type="radio" name="q1" value="A" style="display:none"></li>
    <li data="B"><a href="javascript:void(0);"><i class="fl">B</i><div class="fl">1919年</div></a><input type="radio" name="q1" value="B" style="display:none"></li>
    <li data="C"><a href="javascript:void(0);"><i class="fl">C</i><div class="fl">1921年</div></a><input type="radio" name="q1" value="C" style="display:none"></li>
    <li data="D"><a href="javascript:void(0);"><i class="fl">D</i><div class="fl">1949年</div></a><input type="radio" name="q1" value="D" style="display:none"></li>
  </ul>
</div>

<div class="TiMu" id="q2">
  <div class="Zy_TItle clearfix">
    <div class="fl"><i>2</i>【多选题】下列属于学习通答题常见题型的选项有哪些？</div>
  </div>
  <ul class="Zy_ulTop">
    <li data="A"><a href="javascript:void(0);"><i class="fl">A</i><div class="fl">单选题</div></a><input type="checkbox" name="q2" value="A" style="display:none"></li>
    <li data="B"><a href="javascript:void(0);"><i class="fl">B</i><div class="fl">多选题</div></a><input type="checkbox" name="q2" value="B" style="display:none"></li>
    <li data="C"><a href="javascript:void(0);"><i class="fl">C</i><div class="fl">判断题</div></a><input type="checkbox" name="q2" value="C" style="display:none"></li>
  </ul>
</div>

<div class="TiMu" id="q3">
  <div class="Zy_TItle clearfix">
    <div class="fl"><i>3</i>【判断题】学习通是超星公司推出的在线学习平台。</div>
  </div>
  <ul class="Zy_ulTop">
    <li data="A"><a href="javascript:void(0);"><i class="fl">A</i><div class="fl">正确</div></a><input type="radio" name="q3" value="A" style="display:none"></li>
    <li data="B"><a href="javascript:void(0);"><i class="fl">B</i><div class="fl">错误</div></a><input type="radio" name="q3" value="B" style="display:none"></li>
  </ul>
</div>

<div class="TiMu" id="q4">
  <div class="Zy_TItle clearfix"><div class="fl"><i>4</i>【填空题】HTTP 的默认端口是（　）。</div></div>
  <div class="Cy_ulTop"><input type="text" name="q4" /></div>
</div>

<div class="btnBox">
  <div class="saveBtn" id="saveBtn">暂时保存</div>
  <div class="subBtn" id="pageSubmit">提交</div>
</div>
</body></html>`;

/* ---------- 环境搭建 ---------- */
const dom = new JSDOM(FIXTURE, { url: 'https://mooc1.chaoxing.com/mycourse/studentwork?courseId=1&workId=2', pretendToBeVisual: true });
const win = dom.window;

function innerTextOf(el) {
  let out = '';
  for (const node of el.childNodes) {
    if (node.nodeType === 3) {
      out += node.textContent;
    } else if (node.nodeType === 1) {
      const isBlock = /^(DIV|P|LI|UL|OL|H[1-6]|TR|TABLE|SECTION|ARTICLE|LABEL)$/.test(node.tagName);
      const t = innerTextOf(node);
      if (t) out += isBlock ? ' ' + t + ' ' : t;
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}
Object.defineProperty(win.HTMLElement.prototype, 'innerText', {
  configurable: true,
  get() { return innerTextOf(this); },
  set(v) { this.textContent = v; }
});
win.Element.prototype.getBoundingClientRect = function () {
  return { width: 120, height: 24, top: 0, left: 0, right: 120, bottom: 24, x: 0, y: 0 };
};
win.getComputedStyle = function (el) {
  const style = el && el.style ? el.style : {};
  return { visibility: style.visibility || 'visible', display: style.display || 'block' };
};

/* 模拟学习通前端：点击选项 li 时给 li 加 cur 类，并勾选隐藏 radio/checkbox */
win.document.addEventListener('click', function (e) {
  const t = e.target;
  const li = t && t.closest ? t.closest('.Zy_ulTop li') : null;
  if (!li) return;
  const ul = li.parentElement;
  Array.prototype.forEach.call(ul.children, function (x) {
    x.classList.remove('cur');
    const r = x.querySelector('input');
    if (r) r.checked = false;
  });
  li.classList.add('cur');
  const radio = li.querySelector('input');
  if (radio) radio.checked = true;
}, true);

/* ---------- 全局注入 ---------- */
let promptLog = [];
let submitClicks = 0;
let saveClicks = 0;
let aiCalls = 0;

/** 按题干判题型的智能桩：模拟真实模型逐题作答（每题一次调用） */
function stubAnswer(promptText) {
  if (promptText.indexOf('填空题') !== -1) return '{"answer":"80"}';
  if (promptText.indexOf('多选题') !== -1) return '{"answer":"A,C"}';
  if (promptText.indexOf('判断题') !== -1) return '{"answer":"错误"}';
  if (promptText.indexOf('中国的近代史') !== -1) return '{"answer":"A"}';
  return '{"answer":"A"}';
}

global.window = win;
global.document = win.document;
global.location = win.location;
global.getComputedStyle = win.getComputedStyle;
global.MouseEvent = win.MouseEvent;
global.Event = win.Event;
global.HTMLInputElement = win.HTMLInputElement;
global.HTMLTextAreaElement = win.HTMLTextAreaElement;
global.Element = win.Element;
global.setInterval = () => 0;
global.clearInterval = () => {};
global.MutationObserver = class { observe() {} };
global.fetch = () => Promise.reject(new Error('no fetch'));
global.chrome = {
  runtime: {
    onMessage: { addListener() {} },
    getURL: (p) => p,
    lastError: null,
    sendMessage(msg, cb) {
      if (msg && msg.type === 'LLM_CHAT') {
        const userText = msg.messages && msg.messages[1] ? msg.messages[1].content : '';
        promptLog.push(userText);
        aiCalls += 1;
        if (cb) cb({ ok: true, answer: stubAnswer(userText), model: 'stub' });
        return;
      }
      if (cb) cb({ ok: true });
    }
  },
  storage: {
    local: {
      get(k, cb) {
        if (k === 'cx_settings') cb({ cx_settings: { autoAnswer: false, autoPlay: false, skipDialog: false, mute: false, speed: 1 } });
        else cb({});
      },
      set(o, cb) { if (cb) cb(); }
    }
  }
};

const mod = require('./content.js');
const st = win.document.querySelectorAll('.Zy_ulTop li');
Array.prototype.forEach.call(st, function (li) { /* 记录用 */ });
win.document.getElementById('pageSubmit').addEventListener('click', function () { submitClicks += 1; });
win.document.getElementById('saveBtn').addEventListener('click', function () { saveClicks += 1; });

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); }
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async function run() {
  /* 1. 题目分组 */
  const groups = mod.findQuestionGroups();
  check('识别题目数=4', groups.length === 4, groups.length);

  const q1 = win.document.getElementById('q1');
  const q2 = win.document.getElementById('q2');
  const q3 = win.document.getElementById('q3');
  const q4 = win.document.getElementById('q4');

  /* 2. 题干解析（关键修复点） */
  const stem1 = mod.getStem(q1, mod.collectOptions(q1));
  check('题干1 去掉了题号', stem1.indexOf('【单选题】中国的近代史') === 0, stem1);
  check('题干1 有效', mod.validStem(stem1) === true, stem1);
  const stem4 = mod.getStem(q4, []);
  check('填空题题干有效', mod.validStem(stem4) === true, stem4);

  /* 3. 选项解析 */
  const opts1 = mod.collectOptions(q1);
  check('选项数=4', opts1.length === 4, opts1.length);
  check('选项字母 A-D', opts1.map((o) => o.letter).join('') === 'ABCD', opts1.map((o) => o.letter));
  check('选项文本去前缀', opts1[0].text === '1840年' && opts1[3].text === '1949年', opts1.map((o) => o.text));

  /* 4. 选中态识别（学习通 cur 挂在祖先 li 上） */
  check('初始未选中', mod.selectedState(opts1[0]) === false);

  /* 5. 一键答题全流程：4 道题（单/多/判断/填空）各一次模型调用 */
  mod.__setSettings({ autoAnswer: false, autoPlay: false, skipDialog: false, mute: false, speed: 1, useAI: true, useBank: false, retry: 0, fillInputs: true, autoSubmitPage: false });
  const r1 = await mod.answerQuiz(true);
  check('answerQuiz 返回成功', r1 && r1.ok === true, r1);

  const liA1 = q1.querySelector('.Zy_ulTop li[data="A"]');
  check('Q1 单选 A 被选中', mod.selectedState({ el: liA1, input: liA1.querySelector('input') }) === true);
  check('Q1 隐藏 radio 已勾选', liA1.querySelector('input').checked === true);

  const liA2 = q2.querySelector('.Zy_ulTop li[data="A"]');
  const liC2 = q2.querySelector('.Zy_ulTop li[data="C"]');
  check('Q2 多选 A 选中', mod.selectedState({ el: liA2, input: liA2.querySelector('input') }) === true);
  check('Q2 多选 C 选中', mod.selectedState({ el: liC2, input: liC2.querySelector('input') }) === true);

  const liB3 = q3.querySelector('.Zy_ulTop li[data="B"]');
  check('Q3 判断题选中"错误"', mod.selectedState({ el: liB3, input: liB3.querySelector('input') }) === true);

  check('Q4 填空题已写入 80', q4.querySelector('input[type="text"]').value === '80', q4.querySelector('input[type="text"]').value);

  /* 6. 不再空烧模型调用：4 题 = 4 次，且题干干净 */
  check('模型调用次数=4（每题一次）', aiCalls === 4, aiCalls);
  const badPrompt = promptLog.filter((p) => p.indexOf('选项点击') !== -1 || /^题目：\d+$/.test(p.trim()));
  check('无乱码题干送入模型', badPrompt.length === 0, badPrompt);
  check('题干含真实题目文本', promptLog.some((p) => p.indexOf('中国的近代史') !== -1), promptLog.length);
  check('题干含多选题原文', promptLog.some((p) => p.indexOf('常见题型') !== -1));
  check('填空题走填空提示词', promptLog.some((p) => p.indexOf('HTTP 的默认端口') !== -1));

  /* 7. 页面级提交按钮不被误点（默认 autoSubmitPage=false） */
  check('未自动点击整页提交', submitClicks === 0, submitClicks);

  /* 8. 重复执行不重复作答、不重复调用模型 */
  const callsBefore = aiCalls;
  await mod.answerQuiz(true);
  check('重复执行不再新增 AI 调用', aiCalls === callsBefore, { before: callsBefore, after: aiCalls });
  check('重复执行不重复提交', submitClicks === 0, submitClicks);

  /* 9. 诊断输出可读 */
  const dump = mod.dumpQuestions();
  check('诊断含题干', dump.indexOf('【单选题】中国的近代史') !== -1, dump.slice(0, 300));
  check('诊断含选中态', dump.indexOf('当前选中：是') !== -1);
  check('诊断含候选节点统计', dump.indexOf('候选节点') !== -1);

  /* 10. 提交按钮识别：命中"提交"，绝不点"暂时保存" */
  const submitBtn = mod.findSubmitButton();
  check('找到整页提交按钮', !!submitBtn && submitBtn.id === 'pageSubmit', submitBtn && submitBtn.id);
  check('提交按钮文本为"提交"', submitBtn && String(submitBtn.innerText).trim() === '提交');

  /* 11. autoSubmitPage 关闭时不提交（前面已断言 submitClicks===0） */
  check('关闭开关时未点保存', saveClicks === 0, saveClicks);

  /* 12. autoSubmitPage 打开时自动提交一次且仅一次 */
  mod.__setSettings({ autoAnswer: false, autoPlay: false, skipDialog: false, mute: false, speed: 1, useAI: true, useBank: false, retry: 0, fillInputs: true, autoSubmitPage: true });
  mod.autoSubmitTick();
  check('开启开关后自动点击提交', submitClicks === 1, submitClicks);
  check('标记为已提交', mod.__flags().pageSubmitDone === true);
  mod.autoSubmitTick();
  await mod.answerQuiz(true);
  check('重复触发不重复提交', submitClicks === 1, submitClicks);
  check('全程未点"暂时保存"', saveClicks === 0, saveClicks);

  /* 13. 弹窗处理：提示框 / 提交确认 / 任务点未完成 */
  const baseSet = { autoAnswer: false, autoPlay: false, skipDialog: true, mute: false, speed: 1, autoNext: true, useAI: true, useBank: false, retry: 0, fillInputs: true, autoSubmitPage: false };

  // 13.1 「任务点未完成」→ 点「下一节」，绝不点「去学习」
  mod.__setSettings(baseSet);
  let goStudy = 0, goNext = 0;
  const dlg1 = document.createElement('div');
  dlg1.className = 'dialog';
  dlg1.innerHTML = '<div class="tit">提示</div><div class="con">当前章节还有任务点未完成，是否去完成？</div>' +
    '<div class="btnBox"><span class="go">去学习</span><span class="next">下一节</span></div>';
  document.body.appendChild(dlg1);
  dlg1.querySelector('.go').addEventListener('click', () => { goStudy += 1; });
  dlg1.querySelector('.next').addEventListener('click', () => { goNext += 1; });
  check('弹窗分类=任务点未完成', mod.classifyDialog(String(dlg1.innerText)) === 'incomplete');
  mod.__resetDialogThrottle();
  check('处理了任务点未完成弹窗', mod.skipDialogs() === true);
  check('点了「下一节」', goNext === 1, goNext);
  check('未点「去学习」', goStudy === 0, goStudy);
  dlg1.remove();

  // 13.2 普通提示弹窗 → 点「确定」
  let okClicks = 0;
  const dlg2 = document.createElement('div');
  dlg2.className = 'popBox';
  dlg2.innerHTML = '<div>操作成功</div><div class="ops"><span>确定</span></div>';
  document.body.appendChild(dlg2);
  dlg2.querySelector('span').addEventListener('click', () => { okClicks += 1; });
  check('弹窗分类=普通提示', mod.classifyDialog(String(dlg2.innerText)) === 'ok');
  mod.__resetDialogThrottle();
  check('处理普通提示弹窗', mod.skipDialogs() === true);
  check('点了「确定」', okClicks === 1, okClicks);
  dlg2.remove();

  // 13.3 提交确认 → 点「确定提交」，绝不点「取消」
  let confirmClicks = 0, cancelClicks = 0;
  const dlg3 = document.createElement('div');
  dlg3.className = 'dialog';
  dlg3.innerHTML = '<div class="con">确定提交本次作业吗？</div>' +
    '<div class="ops"><span class="cancel">取消</span><span class="ok">确定提交</span></div>';
  document.body.appendChild(dlg3);
  dlg3.querySelector('.cancel').addEventListener('click', () => { cancelClicks += 1; });
  dlg3.querySelector('.ok').addEventListener('click', () => { confirmClicks += 1; });
  check('弹窗分类=提交确认', mod.classifyDialog(String(dlg3.innerText)) === 'submit');
  mod.__resetDialogThrottle();
  check('处理提交确认弹窗', mod.skipDialogs() === true);
  check('点了「确定提交」', confirmClicks === 1, confirmClicks);
  check('未点「取消」', cancelClicks === 0, cancelClicks);
  dlg3.remove();

  // 13.4 autoNext 关闭时不跳过「任务点未完成」
  mod.__setSettings(Object.assign({}, baseSet, { autoNext: false }));
  let goNext2 = 0;
  const dlg4 = document.createElement('div');
  dlg4.className = 'dialog';
  dlg4.innerHTML = '<div class="con">当前章节还有任务点未完成，是否去完成？</div>' +
    '<div class="btnBox"><span class="go">去学习</span><span class="next">下一节</span></div>';
  document.body.appendChild(dlg4);
  dlg4.querySelector('.next').addEventListener('click', () => { goNext2 += 1; });
  mod.__resetDialogThrottle();
  check('autoNext 关闭时不处理任务点弹窗', mod.skipDialogs() === false && goNext2 === 0, goNext2);
  dlg4.remove();

  // 13.5 章节切换重置 pageSubmitDone
  check('章节切换前 pageSubmitDone=true', mod.__flags().pageSubmitDone === true);
  win.history.pushState({}, '', '/mycourse/studentwork?courseId=1&workId=999');
  mod.checkChapterChange();
  check('章节切换后 pageSubmitDone 重置', mod.__flags().pageSubmitDone === false);

  /* 14. 「下一节」识别：学习通底部是 <div class="jb_btn">下一节</div> 这类非标准按钮 */
  mod.__setSettings(Object.assign({}, baseSet, { autoNext: true }));
  let nextClicks = 0, prevClicks = 0;
  const bar = document.createElement('div');
  bar.className = 'prev_next';
  bar.innerHTML = '<div class="jb_btn" id="prevBtn">上一节</div><div class="jb_btn" id="nextBtn">下一节</div>';
  document.body.appendChild(bar);
  bar.querySelector('#prevBtn').addEventListener('click', () => { prevClicks += 1; });
  bar.querySelector('#nextBtn').addEventListener('click', () => { nextClicks += 1; });

  const nb = mod.findNextButton();
  check('识别非标准「下一节」按钮', !!nb && nb.id === 'nextBtn', nb && nb.id);
  check('按文本能找到该 div', mod.findClickableByText(['下一节'], 6) === bar.querySelector('#nextBtn'));

  mod.clickNextChapter();
  check('clickNextChapter 点了「下一节」', nextClicks === 1, nextClicks);
  check('未点「上一节」', prevClicks === 0, prevClicks);

  // ensureAdvance：结果页停留时兜底续点，节流内不重复
  mod.__setSubmitted(true);
  mod.__resetDialogThrottle();
  const adv1 = mod.ensureAdvance();
  check('已提交后兜底进入下一节', adv1 === true && nextClicks === 2, { adv1, nextClicks });
  const adv2 = mod.ensureAdvance();
  check('节流内不重复点击', adv2 === false && nextClicks === 2, { adv2, nextClicks });
  mod.__setSubmitted(false);
  bar.remove();

  /* 15. 结果页续进：即使内部提交标记丢失，凭"我的答案"也能识别并续点下一节 */
  mod.__setSettings(Object.assign({}, baseSet, { autoNext: true }));
  mod.__setSubmitted(false);

  const resBox = document.createElement('div');
  resBox.id = 'resultBox';
  resBox.innerHTML = '<div>我的答案：ABCD</div><div>33.3 分</div>';
  document.body.appendChild(resBox);
  check('检测到结果页', mod.resultsDetected() === true, mod.resultsDetected());

  let nextClicks2 = 0;
  const nav2 = document.createElement('div');
  nav2.className = 'jb_btn';
  nav2.id = 'navNext2';
  nav2.textContent = '下一节';
  document.body.appendChild(nav2);
  nav2.addEventListener('click', () => { nextClicks2 += 1; });

  mod.__resetDialogThrottle();
  const adv3 = mod.ensureAdvance();
  check('结果页兜底点下一节（不依赖内部提交标记）', adv3 === true && nextClicks2 === 1, { adv3, nextClicks2 });
  resBox.remove();
  nav2.remove();
  check('移除结果页后不再判定', mod.resultsDetected() === false, mod.resultsDetected());

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('测试异常：', e);
  process.exit(3);
});
