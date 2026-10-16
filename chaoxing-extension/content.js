(function () {
  'use strict';

  /* ================= 配置与状态 ================= */

  var SETTINGS_KEY = 'cx_settings';
  var CACHE_KEY = 'cx_answer_cache';
  var MAX_AI_PER_QUESTION = 3;

  var DEFAULTS = {
    autoPlay: true,
    mute: true,
    speed: 1,
    autoNext: true,
    autoAnswer: true,
    useAI: true,
    useBank: false,
    retry: 2,
    skipDialog: true,
    fillInputs: true,
    autoSubmitPage: true,
    submitGap: 6   // 点"提交"后至少等 N 秒再点"下一节"，避免平台还没记上"已完成"就翻页
  };

  var settings = Object.assign({}, DEFAULTS);
  var bank = [];
  var cache = {};
  var cacheDirty = false;
  var bankTried = false;

  var state = { answered: 0, lastAction: '等待启动', lastError: '', speed: 0, hasVideo: false, aiCalls: 0, cacheHits: 0 };
  var answering = false;
  var lastAnswerAt = 0;
  var pageSubmitDone = false;
  var lastPageSubmitAt = 0;
  var nextWatchTimer = null;
  var seenVideos = new WeakSet();
  var rootStates = new WeakMap();
  var lastDialogActionAt = 0;
  var lastAdvanceAt = 0;
  var lastAskAt = 0;
  var lastChapterKey = '';
  var submitClickedAt = 0;   // 点击"提交"的时刻（0=尚未提交）；提交与下一节必须隔开，等平台记上"已完成"

  /* ================= 纯函数工具（可测试） ================= */

  function norm(s) {
    return String(s == null ? '' : s)
      .normalize('NFKC')
      .replace(/[\s!-\/:-@\[-`{-~]/g, '')
      .replace(/[\u3000-\u303f\uff00-\uffef\u2000-\u206f]/g, '')
      .toLowerCase();
  }

  function tokensOf(s) {
    return String(s || '').match(/[\u4e00-\u9fff]+|[a-z0-9]+/g) || [];
  }

  function letterAt(i) {
    return i >= 0 && i < 26 ? String.fromCharCode(65 + i) : '';
  }

  /** 去题干噪声：题号、分数行、多余空白 */
  function cleanStem(text) {
    return String(text == null ? '' : text)
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^\s*[（(【\[]?\s*\d{1,3}\s*[)）】\].、．,:：]?\s*/, '')
      .replace(/^\s*第\s*\d{1,3}\s*[题問问]\s*/, '')
      .replace(/[（(]\s*(分值|共\s*\d+\s*分|本题\s*\d+\s*分)[^）)]*[)）]/g, '')
      .trim();
  }

  /** 题干有效性判定：太短或纯数字/标点视为解析失败，不送模型 */
  function validStem(stem) {
    var s = String(stem == null ? '' : stem).trim();
    if (s.length < 4) return false;
    var cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
    if (cjk >= 3) return true;
    return (s.match(/[A-Za-z0-9]/g) || []).length >= 4;
  }

  /** 剥离选项前缀：A. / A、 / （A） / "A 文本" */
  function stripOptionPrefix(text) {
    var t = String(text == null ? '' : text).replace(/\u00a0/g, ' ').trim();
    var m = t.match(/^[（(【\[]?\s*([A-Za-z])\s*[)）】\].、．,，:：]+\s*([\s\S]*)$/);
    if (m && String(m[2] || '').trim()) return { letter: m[1].toUpperCase(), text: String(m[2]).trim() };
    var m2 = t.match(/^[（(【\[]?\s*([A-Za-z])\s*[)）】\]]?\s+([\s\S]+)$/);
    if (m2) return { letter: m2[1].toUpperCase(), text: String(m2[2] || '').trim() };
    return { letter: '', text: t };
  }

  /** 构造给大模型的提示词 */
  function buildPrompt(stem, optionTexts, feedback) {
    var lines = [];
    lines.push('你是考试答题助手，请根据题目给出最可能正确的答案。');
    lines.push('题目：' + stem);
    if (optionTexts && optionTexts.length) {
      lines.push('选项：');
      optionTexts.forEach(function (t, i) { lines.push(letterAt(i) + '. ' + t); });
      lines.push('作答要求：单选题只输出一个字母；多选题输出多个字母并用英文逗号分隔；判断题按选项顺序输出对应字母。');
    } else {
      lines.push('这是填空题，作答要求：直接输出答案文本，不要任何前后缀。');
    }
    lines.push('只输出 JSON，形如 {"answer":"A"} 或 {"answer":"A,C"} 或 {"answer":"答案文本"}，不要输出解释。');
    if (feedback) {
      lines.push('上一次给出的答案 ' + feedback + ' 已被系统判定为错误，请不要再给出该答案，重新判断。');
    }
    return lines.join('\n');
  }

  /** 从模型输出中抽出答案，容忍多余文字与代码块 */
  function parseModelAnswer(text) {
    var raw = String(text == null ? '' : text).normalize('NFKC').trim();
    if (!raw) return '';
    var json = null;
    var m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try { json = JSON.parse(m[0]); } catch (e) { json = null; }
    }
    if (json) {
      var v = json.answer != null ? json.answer
        : (json.Answer != null ? json.Answer
          : (json.result != null ? json.result : json.content));
      if (Array.isArray(v)) v = v.join(',');
      if (v != null && String(v).trim()) return String(v).trim();
    }
    var cleaned = raw.replace(/```[a-z]*|```/gi, '').trim();
    if (/^[A-Za-z](\s*[,，、]\s*[A-Za-z])*$/.test(cleaned)) return cleaned.replace(/\s+/g, '');
    var picked = cleaned.match(/\b([A-Z](?:\s*[,，、]\s*[A-Z]){0,5})\b/);
    if (picked) return picked[1].replace(/\s+/g, '');
    return cleaned;
  }

  /** 把答案（字母 / 判断题文字 / 选项文本）映射为选项下标 */
  function resolveIndexes(answer, optionTexts) {
    var result = [];
    if (!optionTexts || !optionTexts.length) return result;
    var n = optionTexts.length;
    var raw = String(answer == null ? '' : answer).normalize('NFKC').replace(/\s+/g, '');
    if (!raw) return result;

    var yes = /^(正确|对|是|true|t|√|y)$/i.test(raw);
    var no = /^(错误|错|否|false|f|×|x|n)$/i.test(raw);
    var upper = raw.toUpperCase();
    var allLetters = upper.match(/[A-Z]/g) || [];
    var valid = allLetters.filter(function (l) { return l.charCodeAt(0) - 65 < n; });

    if (valid.length && valid.length === allLetters.length) {
      valid.forEach(function (l) {
        var i = l.charCodeAt(0) - 65;
        if (result.indexOf(i) === -1) result.push(i);
      });
      return result;
    }

    if (n === 2 && (yes || no)) {
      var truthy = /^(对|正确|是|true|t|√|y)$/i;
      var idxTrue = -1;
      for (var k = 0; k < 2; k++) {
        if (truthy.test(String(optionTexts[k]).trim())) { idxTrue = k; break; }
      }
      if (idxTrue >= 0) return [yes ? idxTrue : 1 - idxTrue];
    }

    var parts = raw.split(/[,;，；、|]+/).map(norm).filter(Boolean);
    parts.forEach(function (p) {
      for (var i = 0; i < n; i++) {
        var ot = norm(optionTexts[i]);
        if (!ot) continue;
        if (ot === p || ot.indexOf(p) !== -1 || p.indexOf(ot) !== -1) {
          if (result.indexOf(i) === -1) result.push(i);
          break;
        }
      }
    });
    return result;
  }

  /** 结合选项自身字母前缀，把答案映射为选项下标 */
  function indexesFromAnswer(answer, options) {
    var texts = options.map(function (o) { return o.text; });
    var raw = String(answer == null ? '' : answer).normalize('NFKC').replace(/\s+/g, '');
    var upper = raw.toUpperCase();
    var allLetters = upper.match(/[A-Z]/g) || [];
    var n = options.length;
    var valid = allLetters.filter(function (l) { return l.charCodeAt(0) - 65 < n; });

    if (valid.length && valid.length === allLetters.length) {
      var out = [];
      valid.forEach(function (l) {
        var target = -1;
        for (var i = 0; i < n; i++) {
          if (options[i].letter === l) { target = i; break; }
        }
        if (target === -1) target = l.charCodeAt(0) - 65;
        if (target >= 0 && target < n && out.indexOf(target) === -1) out.push(target);
      });
      return out;
    }
    return resolveIndexes(answer, texts);
  }

  function lettersOf(value) {
    return String(value == null ? '' : value).toUpperCase().match(/[A-Z]/g) || [];
  }

  function sameLetters(a, b) {
    var x = lettersOf(a);
    var y = lettersOf(b);
    if (!x.length || x.length !== y.length) return false;
    return x.every(function (l) { return y.indexOf(l) !== -1; });
  }

  /** 本地题库检索（兜底） */
  function lookupBank(stem, bankData) {
    if (!Array.isArray(bankData) || !bankData.length || !stem) return null;
    var key = norm(stem);
    if (!key) return null;
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < bankData.length; i++) {
      var q = bankData[i] || {};
      var qk = norm(q.question || q['题目'] || q.title || '');
      if (!qk) continue;
      var score = 0;
      if (qk === key) {
        score = 100;
      } else if (key.length >= 6 && (key.indexOf(qk) !== -1 || qk.indexOf(key) !== -1)) {
        score = 85;
      } else {
        var all = tokensOf(qk);
        var hit = all.filter(function (t) { return t.length >= 2 && key.indexOf(t) !== -1; });
        score = all.length ? (hit.length / all.length) * 75 : 0;
      }
      if (score > bestScore) { bestScore = score; best = q; }
    }
    return bestScore >= 60 ? best : null;
  }

  /* ================= DOM 基础工具 ================= */

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    // 用元素自己所属窗口的 getComputedStyle（跨同源 iframe 时全局那个不适用）
    var win = (el.ownerDocument && el.ownerDocument.defaultView) ||
      (typeof window !== 'undefined' ? window : null);
    if (!win || !win.getComputedStyle) return true;
    var st = win.getComputedStyle(el);
    if (!st) return true;
    return st.visibility !== 'hidden' && st.display !== 'none';
  }

  function isTopFrame() {
    try { return window.top === window; } catch (e) { return false; }
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function videos() {
    return Array.prototype.slice.call(document.querySelectorAll('video'));
  }

  function textOf(el) {
    return ((el && (el.innerText || el.value)) || '').replace(/\s+/g, '');
  }

  /* ================= 视频控制 ================= */

  function applySpeed() {
    var vs = videos();
    for (var i = 0; i < vs.length; i++) {
      var v = vs[i];
      if (Math.abs(v.playbackRate - settings.speed) > 0.001) {
        try { v.playbackRate = settings.speed; } catch (e) { /* 播放器就绪前可能失败 */ }
      }
      if (settings.mute && !v.muted) v.muted = true;
    }
    if (vs.length) state.speed = vs[0].playbackRate;
  }

  function bindVideo(v) {
    if (seenVideos.has(v)) return;
    seenVideos.add(v);
    v.addEventListener('ended', function () {
      if (settings.autoNext) setTimeout(clickNextChapter, 1200);
    });
    v.addEventListener('ratechange', function () { state.speed = v.playbackRate; });
    v.addEventListener('play', function () { state.hasVideo = true; });
  }

  function tick() {
    var vs = videos();
    vs.forEach(bindVideo);
    state.hasVideo = vs.length > 0;
    applySpeed();
    if (settings.autoPlay) {
      vs.forEach(function (v) {
        if (v.paused && !v.ended) {
          var p = v.play();
          if (p && p.catch) p.catch(function () { /* 自动播放策略拦截，忽略 */ });
        }
      });
    }
    checkChapterChange();
    skipDialogs();
    if (settings.autoAnswer && needsWork()) answerQuiz(false);
    else if (settings.autoSubmitPage) autoSubmitTick();
    ensureAdvance();
    reportState();
  }

  function quickQuestionCount() {
    if (!document.querySelector('.TiMu, .Zy_TItle, .ans-videoquiz, .exam-question, .question, .q-item, .subject')) return 0;
    return findQuestionGroups().length;
  }

  /** 上报本 frame 状态，供后台挑选"有题目的 frame" */
  function reportState() {
    try {
      chrome.runtime.sendMessage({
        type: 'FRAME_STATE',
        state: {
          questions: quickQuestionCount(),
          hasVideo: videos().length > 0,
          url: location.href,
          answered: state.answered,
          lastAction: state.lastAction,
          lastError: state.lastError,
          aiCalls: state.aiCalls,
          cacheHits: state.cacheHits,
          speed: state.speed
        }
      }, function () { void chrome.runtime.lastError; });
    } catch (e) { /* 非扩展环境 */ }
  }

  /* ================= 下一节 / 弹窗 ================= */

  // 学习通底部「上一节/下一节」常是 <div class="jb_btn">下一节</div> 这类非标准按钮，
  // 不落在 a/button/.btn 上，故这里扫描更广的标签集，并用"文本精确匹配 + 取最内层"定位。
  var CLICKABLE_SELECTOR = 'a, button, span, div, li, p, strong, em, font, ' +
    'input[type="button"], input[type="submit"], [role="button"], [onclick]';

  function pickInnermost(list) {
    if (!list.length) return null;
    var leafs = list.filter(function (c) {
      return !list.some(function (o) { return o.el !== c.el && c.el.contains(o.el); });
    });
    var pool = leafs.length ? leafs : list;
    pool.sort(function (a, b) { return (a.idx - b.idx) || (a.len - b.len); });
    return pool[0].el;
  }

  /** 需要扫描的文档集合。deep 且为顶层帧时，加入同源子 iframe 文档
      （学习通 studentstudy 的正文"上一节/下一节"常在 iframe 里，顶层帧须能跨进去找） */
  function docsToScan(deep) {
    var docs = [];
    try { docs.push(document); } catch (e) { return docs; }
    if (!deep || !isTopFrame()) return docs;
    try {
      var frames = Array.prototype.slice.call(document.querySelectorAll('iframe'));
      for (var i = 0; i < frames.length; i++) {
        try {
          var cd = frames[i].contentDocument;
          if (cd && docs.indexOf(cd) === -1) docs.push(cd);
        } catch (e) { /* 跨域，跳过 */ }
      }
    } catch (e) { /* ignore */ }
    return docs;
  }

  /** 按文本找可点击元素：优先"完全等于"，其次"包含"；都取最内层，避免点到同名包裹层。
      先用 textContent 做廉价文本筛选，再对幸存者判可见（避免全量触发 reflow，页面卡顿） */
  function findClickableByText(texts, maxLen, deep) {
    var docs = docsToScan(deep);
    var exact = [];
    var loose = [];
    var limit = maxLen || 12;
    docs.forEach(function (doc) {
      var els;
      try { els = doc.querySelectorAll(CLICKABLE_SELECTOR); } catch (e) { return; }
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var raw = (el.textContent || '').replace(/\s+/g, '');
        if (!raw || raw.length > limit) continue;
        var eIdx = -1, lIdx = -1;
        for (var j = 0; j < texts.length; j++) {
          if (eIdx === -1 && raw === texts[j]) eIdx = j;
          if (lIdx === -1 && raw.indexOf(texts[j]) !== -1) lIdx = j;
        }
        if (eIdx === -1 && lIdx === -1) continue;
        if (!visible(el)) continue;
        if (eIdx !== -1) exact.push({ el: el, idx: eIdx, len: raw.length });
        else loose.push({ el: el, idx: lIdx, len: raw.length });
      }
    });
    return pickInnermost(exact) || pickInnermost(loose);
  }

  var NEXT_TEXTS = ['下一节', '下一章', '下一个', '下一任务', '下一课'];

  /** 找"下一节"入口：文本优先，其次按 class/id 含 next 的可点击元素兜底；deep 时跨同源 iframe */
  function findNextButton(deep) {
    var byText = findClickableByText(NEXT_TEXTS, 6, deep);
    if (byText) return byText;
    var docs = docsToScan(deep);
    var cands = [];
    docs.forEach(function (doc) {
      var list;
      try {
        list = Array.prototype.slice.call(
          doc.querySelectorAll('[class*="next"],[class*="Next"],[id*="next"],[id*="Next"]')
        );
      } catch (e) { return; }
      list.forEach(function (e) {
        if (!visible(e)) return;
        var t = textOf(e);
        if (t.length > 8) return;
        if (/上一[节章个]|prev/i.test(t + ' ' + String(e.className || '') + ' ' + String(e.id || ''))) return;
        if (/(下一|next)/i.test(t + ' ' + String(e.className || '') + ' ' + String(e.id || ''))) cands.push(e);
      });
    });
    if (!cands.length) return null;
    cands.sort(function (a, b) { return textOf(a).length - textOf(b).length; });
    return cands[0];
  }

  function isExamLink(a) {
    return /(作业|考试|测验|实验|问卷|讨论|互评)/.test(textOf(a));
  }

  function findNextChapterLink() {
    var links = Array.prototype.slice.call(document.querySelectorAll('a[href*="chapterId"]'))
      .filter(function (a) { return visible(a); });
    if (!links.length) return null;
    var activeIdx = -1;
    for (var i = 0; i < links.length; i++) {
      var self = links[i];
      var holder = self.closest('li, div, span');
      if (/(^|\s)active(\s|$)/.test(String(self.className || '')) ||
          (holder && /(^|\s)active(\s|$)/.test(String(holder.className || '')))) {
        activeIdx = i;
        break;
      }
    }
    if (activeIdx === -1) return null;
    for (var j = activeIdx + 1; j < links.length; j++) {
      if (!isExamLink(links[j])) return links[j];
    }
    return null;
  }

  function clickNextChapter() {
    var btn = findNextButton() ||
      findClickableByText(['继续学习', '继续课程', '进入下一章', '去学习', '继续观看', '继续答题'], 8);
    if (btn) { btn.click(); state.lastAction = '点击下一节按钮：' + textOf(btn); return true; }
    var link = findNextChapterLink();
    if (link) { link.click(); state.lastAction = '点击目录下一节'; return true; }
    state.lastAction = '未找到下一节入口';
    return false;
  }

  /* ---------- 弹窗处理：提示框 / 提交确认 / "任务点未完成" ----------
     学习通在"章节还有任务点未完成"时会弹「提示：当前章节还有任务点未完成，是否去完成？」
     按钮为「去学习」「下一节」。刷课要往前走，故此类弹窗点「下一节」。
     旧逻辑只认「确定/继续/知道了」，所以卡死在这里。 */

  var DIALOG_SELECTOR = [
    '[class*="dialog"]', '[class*="Dialog"]', '[class*="popup"]', '[class*="Popup"]',
    '[class*="popBox"]', '[class*="pop-box"]', '[class*="popLayer"]',
    '[class*="confirm"]', '[class*="Confirm"]', '[class*="msgbox"]', '[class*="MsgBox"]',
    '[class*="message-box"]', '[class*="alert"]', '[class*="Alert"]',
    '[class*="layer"]', '[class*="Layer"]', '[class*="modal"]', '[class*="Modal"]',
    '[class*="tips"]', '[class*="Tips"]', '[class*="z16"]', '[class*="z17"]',
    '[class*="maskDiv"]', '[id*="dialog"]', '[id*="popup"]', '[id*="popBox"]'
  ].join(',');

  // 前进类按钮（"任务点未完成"弹窗优先点这个）
  var DIALOG_NEXT = ['下一节', '下一章', '下一任务', '下一个', '继续学习'];
  // 提交确认类
  var DIALOG_SUBMIT = ['确定提交', '确认提交', '提交', '交卷'];
  // 普通确认/关闭类
  var DIALOG_OK = ['确定', '确认', '继续', '好的', '好', '是', '我知道了', '知道了', '关闭', '完成', '返回'];
  // 绝不自动点的按钮
  var DIALOG_CANCEL = ['取消', '关闭弹窗', '放弃', '暂离', '暂时保存', '保存', '稍后', '以后再说'];

  function dialogButtonsIn(el) {
    var all = Array.prototype.slice.call(
      el.querySelectorAll('a, button, span, div, input[type="button"], input[type="submit"]')
    ).filter(function (b) {
      if (!visible(b)) return false;
      var t = textOf(b);
      return t.length >= 1 && t.length <= 8 && DIALOG_CANCEL.indexOf(t) === -1;
    });
    // 只保留"叶子"按钮，避免点到包裹层（包裹层的文本也等于按钮文本）
    return all.filter(function (b) {
      return !all.some(function (o) { return o !== b && b.contains(o); });
    });
  }

  /** 找出当前可见的弹窗容器（只保留最内层，避免父子重复） */
  function findDialogs() {
    var els = Array.prototype.slice.call(document.querySelectorAll(DIALOG_SELECTOR));
    var out = [];
    els.forEach(function (el) {
      if (!visible(el)) return;
      var t = textOf(el);
      if (!t || t.length > 200) return;
      var btns = dialogButtonsIn(el);
      if (!btns.length) return;
      out.push({ el: el, text: t, btns: btns });
    });
    return out.filter(function (d) {
      return !out.some(function (o) { return o.el !== d.el && d.el.contains(o.el); });
    });
  }

  /** 弹窗语义分类 */
  function classifyDialog(text) {
    if (/未完成|还有.{0,8}任务|任务点.{0,4}(未|没有)|请先完成|是否去完成/.test(text)) return 'incomplete';
    if (/确定.{0,4}提交|确认.{0,4}提交|提交后|交卷|提交答案/.test(text)) return 'submit';
    return 'ok';
  }

  /** 在弹窗按钮里按语义挑一个（先精确匹配，再包含匹配） */
  function pickDialogButton(btns, kind) {
    var order = kind === 'incomplete' ? DIALOG_NEXT
      : kind === 'submit' ? DIALOG_SUBMIT
      : DIALOG_OK;
    var i, j, t;
    for (i = 0; i < order.length; i++) {
      for (j = 0; j < btns.length; j++) {
        if (textOf(btns[j]) === order[i]) return btns[j];
      }
    }
    for (i = 0; i < order.length; i++) {
      for (j = 0; j < btns.length; j++) {
        t = textOf(btns[j]);
        if (t.length <= 6 && t.indexOf(order[i]) !== -1) return btns[j];
      }
    }
    return null;
  }

  function skipDialogs() {
    if (Date.now() - lastDialogActionAt < 2000) return false;
    var dialogs = findDialogs();
    for (var i = 0; i < dialogs.length; i++) {
      var d = dialogs[i];
      var kind = classifyDialog(d.text);
      var btn = null;
      if (kind === 'incomplete') {
        if (!settings.autoNext) continue;
        // 本页仍有题未答完时先不跳过，交给答题流程
        if (settings.autoAnswer && needsWork()) continue;
        btn = pickDialogButton(d.btns, 'incomplete');
        if (btn) { btn.click(); lastDialogActionAt = Date.now(); state.lastAction = '弹窗：任务点未完成 → ' + textOf(btn); return true; }
      } else if (kind === 'submit') {
        if (!settings.skipDialog) continue;
        btn = pickDialogButton(d.btns, 'submit');
        if (btn) { btn.click(); lastDialogActionAt = Date.now(); state.lastAction = '弹窗：确认提交 → ' + textOf(btn); return true; }
      } else {
        if (!settings.skipDialog) continue;
        btn = pickDialogButton(d.btns, 'ok');
        if (btn) { btn.click(); lastDialogActionAt = Date.now(); state.lastAction = '关闭弹窗：' + textOf(btn); return true; }
      }
    }
    return false;
  }

  /** 章节切换（chapterId/jobid 变化）时重置每章状态，避免"下一章后不再提交" */
  function chapterKey() {
    var href = '';
    try { href = String((typeof location !== 'undefined' && location.href) || ''); } catch (e) { href = ''; }
    if (!href) return '';
    var m = href.match(/chapterId=([^&]+)/) ||
            href.match(/[?&]jobid=([^&]+)/) ||
            href.match(/[?&]workId=([^&]+)/);
    return (m && m[1]) || href;
  }

  function checkChapterChange() {
    var k = chapterKey();
    if (!k) return;
    if (lastChapterKey && k !== lastChapterKey) {
      pageSubmitDone = false;
      submitClickedAt = 0;
      rootStates = new WeakMap();
      lastAdvanceAt = 0;
      lastDialogActionAt = 0;
      lastAskAt = 0;
      if (nextWatchTimer) { clearInterval(nextWatchTimer); nextWatchTimer = null; }
      state.lastAction = '检测到章节切换，状态已重置';
    }
    lastChapterKey = k;
  }

  /* ================= 题目结构解析 ================= */

  /** 学习通作业/测验页优先，其次通用结构 */
  var OPTION_SELECTORS = [
    '.Zy_ulTop li', '.Zy_ulBottom li', '.Zy_ulTop > li', '.ZY_ulTop li', '.Zy_ulTop2 li',
    '.TiMu ul li', '.TiMu .option', '.options li', '.option', '.choices li',
    '.answerOption li', 'ul.options li', 'li.option', '.answer li', '.cy li', '.select_li', 'label'
  ];

  var STEM_SELECTORS = [
    '.Zy_TItle .fl', '.Zy_TItle', '.TiMu_title', '.Cy_TItle', '.Cy_TItitle .clearfix',
    '.Cy_TItitle', '.qtContent', '.q-title', '.subject .title', '.stem', '.q-stem'
  ];

  function collectOptions(root) {
    var found = null;
    for (var i = 0; i < OPTION_SELECTORS.length; i++) {
      var els = Array.prototype.slice.call(root.querySelectorAll(OPTION_SELECTORS[i]))
        .filter(function (el) {
          if (!visible(el)) return false;
          var t = String(el.innerText || '').trim();
          return t.length > 0 && t.length < 300;
        });
      if (els.length >= 2) { found = els; break; }
    }
    if (!found) return [];

    // 只保留最内层节点，避免 li / label / a 同时命中同一选项
    var uniq = [];
    found.forEach(function (el) { if (uniq.indexOf(el) === -1) uniq.push(el); });
    var leaves = uniq.filter(function (el) {
      return !uniq.some(function (o) { return o !== el && el.contains(o); });
    });

    var list = [];
    leaves.forEach(function (el, idx) {
      var rawText = String(el.innerText || '').replace(/\u00a0/g, ' ').trim();
      var parsed = stripOptionPrefix(rawText);
      var expected = letterAt(idx);
      // 兜底：形如 "A1840年"（字母与正文之间无分隔符），仅当字母与位置一致时才剥离，避免误伤 "A股市场"
      if (!parsed.letter && expected && rawText.length > 1 && rawText.charAt(0).toUpperCase() === expected) {
        parsed = { letter: expected, text: rawText.slice(1).replace(/^[\s、．.,，:：)）】\]]+/, '').trim() };
      }
      var input = el.querySelector('input[type="radio"], input[type="checkbox"]');
      var dataLetter = '';
      if (el.getAttribute) {
        dataLetter = String(el.getAttribute('data') || el.getAttribute('data-value') || el.getAttribute('value') || '').toUpperCase();
        if (!/^[A-Z]$/.test(dataLetter)) dataLetter = '';
      }
      var item = {
        el: el,
        input: input || (el.parentElement ? el.parentElement.querySelector('input[type="radio"], input[type="checkbox"]') : null),
        letter: parsed.letter || dataLetter || expected,
        text: parsed.text || rawText
      };
      if (!list.some(function (x) { return x.letter === item.letter; })) list.push(item);
    });
    return list;
  }

  function collectFillInputs(root) {
    return Array.prototype.slice.call(
      root.querySelectorAll('input[type="text"], input[type="search"], input:not([type]), textarea')
    ).filter(function (el) { return visible(el) && !el.disabled && !el.readOnly; });
  }

  function getStem(root, options) {
    for (var i = 0; i < STEM_SELECTORS.length; i++) {
      var el = root.querySelector(STEM_SELECTORS[i]);
      if (!el) continue;
      var t = cleanStem(el.innerText || '');
      if (validStem(t)) return t;
    }
    var text = String(root.innerText || '');
    (options || []).forEach(function (o) { text = text.split(o.text).join(''); });
    var lines = text.split('\n').map(cleanStem).filter(validStem);
    return lines.length ? lines.join(' ') : cleanStem(text);
  }

  /** 按"选项叶子节点归属"分组，天然支持一页多题 */
  function findQuestionGroups() {
    var sels = ['.TiMu', '.Zy_TItle', '.ans-videoquiz', '.videoquiz', '.exam-question', '.question', '.q-item', '.subject'];
    var cands = [];
    sels.forEach(function (s) {
      Array.prototype.slice.call(document.querySelectorAll(s)).forEach(function (el) {
        if (visible(el) && cands.indexOf(el) === -1) cands.push(el);
      });
    });

    var groups = [];
    cands.forEach(function (el) {
      var opts = collectOptions(el);
      if (opts.length >= 2 && opts.length <= 12) groups.push({ root: el, opts: opts });
    });
    groups.sort(function (a, b) { return a.opts.length - b.opts.length; });

    var used = [];
    var result = [];
    groups.forEach(function (g) {
      var overlap = g.opts.some(function (o) { return used.indexOf(o.el) !== -1; });
      if (overlap) return;
      used = used.concat(g.opts.map(function (o) { return o.el; }));
      result.push(g);
    });

    if (settings.fillInputs) {
      var fillCands = Array.prototype.slice.call(
        document.querySelectorAll('.TiMu, .Zy_TItle, .subject, .question, .fill-in, .fillblank')
      );
      fillCands.forEach(function (el) {
        if (!visible(el)) return;
        if (collectOptions(el).length >= 2) return;
        var fills = collectFillInputs(el);
        if (!fills.length) return;
        if (fills.some(function (f) { return used.indexOf(f) !== -1; })) return;
        used = used.concat(fills);
        result.push({ root: el, opts: [] });
      });
    }
    return result;
  }

  function findQuestionRoots() {
    return findQuestionGroups().map(function (g) { return g.root; });
  }

  var SUBMIT_TEXTS = ['提交', '提交答案', '提交试卷', '确认提交', '交卷', '完成作答', '确定提交'];
  var SAVE_TEXTS = ['保存', '暂存', '暂离'];

  /** 找提交按钮：先精确选择器，再按文本兜底；永不点"保存/暂存" */
  function findSubmitButton(scope) {
    var root = scope || document;
    var preciseSels = [
      '#submitBtn', '[id*="submit"]', '[class*="submit"]', '[id*="subBtn"]', '[class*="subBtn"]',
      '[id*="sub_btn"]', '[class*="sub_btn"]', '[class*="sub"]', '[id*="sub"]',
      'button', 'input[type="submit"]', 'input[type="button"]', '.btn', '.Btn'
    ];
    var cands = [];
    preciseSels.forEach(function (s) {
      Array.prototype.slice.call(root.querySelectorAll(s)).forEach(function (el) {
        if (cands.indexOf(el) === -1) cands.push(el);
      });
    });
    Array.prototype.slice.call(root.querySelectorAll('a, div, span, button, input')).forEach(function (el) {
      if (cands.indexOf(el) === -1) cands.push(el);
    });

    function textHasSubmit(el) {
      var t = textOf(el);
      return SUBMIT_TEXTS.some(function (s) { return t.indexOf(s) !== -1; });
    }

    var best = null;
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      if (!visible(el)) continue;
      var t = textOf(el);
      if (!t || t.length > 12) continue;
      if (SAVE_TEXTS.some(function (s) { return t.indexOf(s) !== -1; })) continue;

      var hit = -1;
      for (var j = 0; j < SUBMIT_TEXTS.length; j++) {
        if (t === SUBMIT_TEXTS[j]) { hit = j; break; }
      }
      if (hit === -1) {
        for (var j2 = 0; j2 < SUBMIT_TEXTS.length; j2++) {
          if (t.indexOf(SUBMIT_TEXTS[j2]) !== -1) { hit = j2 + 100; break; }
        }
      }
      if (hit === -1) continue;

      var tag = String(el.tagName || '').toLowerCase();
      var idc = String(el.className || '') + ' ' + String(el.id || '');
      var score = hit < 100 ? (100 - hit) : (50 - (hit - 100));
      if (/btn|sub|submit|commit/i.test(idc)) score += 15;
      if (tag === 'button' || tag === 'input' || tag === 'a') score += 10;
      score -= t.length;
      var wrapsOther = cands.some(function (o) {
        return o !== el && el.contains(o) && textHasSubmit(o);
      });
      if (wrapsOther) score -= 40;
      if (!best || score > best.score) best = { el: el, score: score };
    }
    return best ? best.el : null;
  }

  function findRetryButton() {
    return findClickableByText(['重新作答', '再答一次', '重新回答', '重做', '重新测试'], 6);
  }

  function findResumeButton() {
    return findClickableByText(['继续播放', '继续学习', '继续', '关闭', '我知道了', '知道了', '完成', '确定'], 5);
  }

  /** 只在结果节点上判定对错，避免题干里出现"正确"导致误判 */
  function verdictOf(root) {
    var nodes = Array.prototype.slice.call(root.querySelectorAll(
      '[class*="wrong"], [class*="error"], [class*="right"], [class*="correct"], [class*="dui"], [class*="cuo"], .result, .jieguo, .answer-result'
    ));
    for (var i = 0; i < nodes.length; i++) {
      var t = textOf(nodes[i]);
      if (/错误|不正确|答错/.test(t)) return 'wrong';
      if (/正确|答对/.test(t)) return 'right';
    }
    var whole = textOf(root);
    if (/(回答错误|答案错误|作答错误|回答不正确|答案不正确)/.test(whole)) return 'wrong';
    if (/(回答正确|答案正确|作答正确)/.test(whole)) return 'right';
    return '';
  }

  var SELECT_TOKENS = ['selected', 'active', 'checked', 'choosed', 'cur', 'sel', 'on', 'dui', 'right'];

  function hasSelectToken(el) {
    if (!el || !el.className || typeof el.className !== 'string') return false;
    var parts = el.className.split(/\s+/);
    for (var i = 0; i < parts.length; i++) {
      if (SELECT_TOKENS.indexOf(parts[i].toLowerCase()) !== -1) return true;
    }
    return /(selected|choosed|checked)/i.test(el.className);
  }

  /** 选中态：input.checked / 自身 class / 内部节点 class / 祖先 li 的 class（学习通把 cur 挂 li 上） */
  function selectedState(opt) {
    if (opt.input && opt.input.checked) return true;
    if (opt.el.getAttribute && opt.el.getAttribute('aria-checked') === 'true') return true;
    if (hasSelectToken(opt.el)) return true;
    var inner = opt.el.querySelector && opt.el.querySelector('input, i, span, em');
    if (inner && hasSelectToken(inner)) return true;
    var p = opt.el.parentElement;
    for (var depth = 0; p && depth < 3; p = p.parentElement, depth += 1) {
      if (hasSelectToken(p)) return true;
      var pin = p.querySelector && p.querySelector('input[type="radio"], input[type="checkbox"]');
      if (pin && pin.checked) return true;
    }
    return false;
  }

  function dispatchClick(el) {
    if (!el || !el.dispatchEvent) return;
    try {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } catch (e) {
      try { el.click(); } catch (e2) { /* ignore */ }
    }
  }

  /** 依次尝试 input / 选项元素 / 内部节点 / 祖先 li，命中选中态即停，避免反复切换 */
  function clickOption(opt) {
    if (selectedState(opt)) return true;
    var targets = [];
    if (opt.input) targets.push(opt.input);
    targets.push(opt.el);
    var inner = opt.el.querySelector && opt.el.querySelector('label, i, span.num, a, em');
    if (inner) targets.push(inner);
    var holder = opt.el.closest && opt.el.closest('li');
    if (holder && holder !== opt.el) targets.push(holder);

    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      if (!t || !t.dispatchEvent) continue;
      try { t.click(); } catch (e) { /* ignore */ }
      if (selectedState(opt)) return true;
      dispatchClick(t);
      if (selectedState(opt)) return true;
    }
    return selectedState(opt);
  }

  function clearSelections(options) {
    options.forEach(function (o) {
      if (o.input && o.input.checked) {
        try { o.input.click(); } catch (e) { /* ignore */ }
      }
    });
  }

  function selectOptions(options, indexes) {
    var seq = Promise.resolve();
    var ok = [];
    indexes.forEach(function (i) {
      seq = seq.then(function () {
        var o = options[i];
        if (!o) return null;
        if (clickOption(o)) return sleep(150);
        return sleep(250).then(function () {
          if (!selectedState(o)) clickOption(o);
          return sleep(250);
        });
      }).then(function () {
        if (options[i] && selectedState(options[i])) ok.push(i);
      });
    });
    return seq.then(function () { return ok; });
  }

  function setInputValue(el, value) {
    try {
      var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, value);
    } catch (e) {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ================= 答案缓存 ================= */

  function loadCache() {
    try {
      chrome.storage.local.get(CACHE_KEY, function (d) { cache = (d && d[CACHE_KEY]) || {}; });
    } catch (e) { cache = {}; }
  }

  function saveCache() {
    if (!cacheDirty) return;
    cacheDirty = false;
    var keys = Object.keys(cache);
    if (keys.length > 500) {
      var trimmed = {};
      keys.slice(keys.length - 500).forEach(function (k) { trimmed[k] = cache[k]; });
      cache = trimmed;
    }
    try { chrome.storage.local.set({ [CACHE_KEY]: cache }); } catch (e) { /* ignore */ }
  }

  function rememberAnswer(stem, answer) {
    var key = norm(stem);
    if (!key) return;
    cache[key] = cache[key] || { answer: answer, bad: [] };
    cache[key].answer = answer;
    cache[key].bad = cache[key].bad || [];
    cacheDirty = true;
  }

  function rememberWrong(stem, letters) {
    var key = norm(stem);
    if (!key || !letters || !letters.length) return;
    cache[key] = cache[key] || { answer: '', bad: [] };
    cache[key].bad = (cache[key].bad || []).concat(letters);
    cacheDirty = true;
  }

  function lookupCache(stem) {
    var entry = cache[norm(stem)];
    if (!entry || !entry.answer) return null;
    var badList = entry.bad || [];
    var repeated = badList.some(function (b) { return sameLetters(b, entry.answer); });
    return { answer: entry.answer, bad: badList, stale: repeated };
  }

  /* ================= 大模型调用 ================= */

  function askAI(messages) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ type: 'LLM_CHAT', messages: messages }, function (resp) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(resp || { ok: false, error: '后台无响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  function getAnswer(stem, options, st) {
    var texts = options.map(function (o) { return o.text; });
    var cached = lookupCache(stem);

    if (cached && !cached.stale) {
      state.cacheHits += 1;
      state.lastAction = '使用缓存答案：' + cached.answer;
      return Promise.resolve({ answer: cached.answer, from: 'cache' });
    }

    var canAskAI = settings.useAI && (st.aiCalls || 0) < MAX_AI_PER_QUESTION;
    var chain;
    if (canAskAI) {
      st.aiCalls = (st.aiCalls || 0) + 1;
      var feedback = (st.wrongLetters || []).join(',') || (cached && cached.bad ? cached.bad.join(',') : '');
      chain = askAI([
        { role: 'system', content: '你是学习通课程答题助手，只输出 JSON，不输出任何解释。' },
        { role: 'user', content: buildPrompt(stem, texts, feedback) }
      ]).then(function (resp) {
        if (resp && resp.ok && resp.answer) {
          var parsed = parseModelAnswer(resp.answer);
          if (parsed) {
            state.aiCalls += 1;
            state.lastAction = 'AI 返回答案：' + parsed;
            return { answer: parsed, from: 'ai', raw: resp.answer };
          }
          state.lastError = 'AI 返回无法解析：' + String(resp.answer).slice(0, 40);
        } else if (resp && resp.error) {
          state.lastError = 'AI 调用失败：' + resp.error;
        }
        return null;
      });
    } else {
      chain = Promise.resolve(null);
    }

    return chain.then(function (aiResult) {
      if (aiResult) return aiResult;
      if (settings.useBank) {
        var hit = lookupBank(stem, bank);
        if (hit) return { answer: hit.answer, from: 'bank' };
      }
      return null;
    });
  }

  /* ================= 答题流程 ================= */

  function getRootState(root) {
    var st = rootStates.get(root);
    if (!st) {
      st = {
        phase: 'new', tries: 0, wrongLetters: [], chosenLetters: [],
        submitted: false, lastAt: 0, fails: 0, cooldownUntil: 0, aiCalls: 0
      };
      rootStates.set(root, st);
    }
    return st;
  }

  function needsWork() {
    var groups = findQuestionGroups();
    for (var i = 0; i < groups.length; i++) {
      var st = rootStates.get(groups[i].root);
      if (!st) return true;
      if (st.phase === 'new' || st.phase === 'retry') return true;
      if (st.phase === 'cooldown' && Date.now() >= st.cooldownUntil) return true;
      if (st.phase === 'submitted' && Date.now() - st.lastAt > 5000) return true;
    }
    return false;
  }

  function avoidWrongIndexes(indexes, options, st) {
    var bad = (st.wrongLetters || []).map(function (l) { return String(l).toUpperCase(); });
    if (!bad.length) return indexes;
    var filtered = indexes.filter(function (i) {
      return options[i] && bad.indexOf(options[i].letter) === -1;
    });
    if (filtered.length) return filtered;
    var untried = [];
    for (var i = 0; i < options.length; i++) {
      if (bad.indexOf(options[i].letter) === -1) untried.push(i);
    }
    return untried.length ? [untried[0]] : indexes;
  }

  function attemptRoot(root, st) {
    var options = collectOptions(root);
    var fills = settings.fillInputs ? collectFillInputs(root) : [];
    var stem = getStem(root, options);

    if (!validStem(stem)) {
      st.phase = 'done';
      state.lastAction = '题干无法识别，已跳过（点「诊断题目」可查看解析详情）';
      return Promise.resolve(false);
    }
    if (!options.length && !fills.length) {
      st.phase = 'done';
      state.lastAction = '未找到选项或输入框，已跳过';
      return Promise.resolve(false);
    }

    return getAnswer(stem, options, st).then(function (entry) {
      if (!entry) {
        st.phase = (st.aiCalls >= MAX_AI_PER_QUESTION) ? 'done' : 'retry';
        state.lastAction = '未取得答案：' + stem.slice(0, 20) +
          (st.aiCalls >= MAX_AI_PER_QUESTION ? '（AI 调用已达上限，停止重试）' : '');
        return false;
      }

      var selectedPromise;
      if (options.length) {
        var idx = indexesFromAnswer(entry.answer, options);
        idx = avoidWrongIndexes(idx, options, st);
        if (!idx.length) {
          var next = 0;
          for (var i = 0; i < options.length; i++) {
            if (st.wrongLetters.indexOf(options[i].letter) === -1) { next = i; break; }
          }
          idx = [next];
        }
        st.chosenLetters = idx.map(function (i) { return options[i] ? options[i].letter : ''; });
        clearSelections(options);
        selectedPromise = selectOptions(options, idx).then(function (ok) {
          if (!ok.length) {
            st.fails = (st.fails || 0) + 1;
            if (st.fails >= 2) {
              st.phase = 'cooldown';
              st.cooldownUntil = Date.now() + 20000;
              state.lastAction = '选项点击未生效，暂停 20 秒（第 ' + st.fails + ' 次失败）';
            } else {
              state.lastAction = '选项点击未生效：' + stem.slice(0, 16);
            }
            return false;
          }
          st.fails = 0;
          return true;
        });
      } else {
        fills.forEach(function (el) { setInputValue(el, entry.answer); });
        st.chosenLetters = [entry.answer];
        selectedPromise = Promise.resolve(true);
      }

      return selectedPromise.then(function (ok) {
        if (!ok) return false;
        return sleep(250).then(function () {
          var localSubmit = findSubmitButton(root);
          state.answered += 1;
          rememberAnswer(stem, entry.answer);

          if (localSubmit) {
            localSubmit.click();
            st.submitted = true;
            st.lastAt = Date.now();
            st.phase = 'submitted';
            state.lastAction = '已作答并提交（' + fromLabel(entry.from) + '）：' + stem.slice(0, 20);
          } else {
            st.phase = 'selected';
            state.lastAction = '已选好答案（' + fromLabel(entry.from) + '）：' + stem.slice(0, 20) +
              (settings.autoSubmitPage ? '，等待整页提交' : '，题目外提交通道未自动点击');
          }
          return true;
        });
      });
    });
  }

  function fromLabel(from) {
    return from === 'ai' ? 'AI' : from === 'cache' ? '缓存' : '题库';
  }

  function handleRoot(root) {
    var st = getRootState(root);
    if (st.phase === 'done' || st.phase === 'selected') return Promise.resolve(false);
    if (st.phase === 'cooldown') {
      if (Date.now() < st.cooldownUntil) return Promise.resolve(false);
      st.phase = 'retry';
      st.fails = 0;
    }

    var verdict = verdictOf(root);
    if (verdict === 'right') {
      st.phase = 'done';
      state.lastAction = '已确认回答正确';
      return Promise.resolve(true);
    }
    if (verdict === 'wrong') {
      st.wrongLetters = st.wrongLetters.concat(st.chosenLetters || []);
      st.tries += 1;
      rememberWrong(getStem(root, collectOptions(root)), st.chosenLetters || []);
      if (st.tries > (parseInt(settings.retry, 10) || 0)) {
        st.phase = 'done';
        state.lastAction = '答错且重试次数用尽';
        return Promise.resolve(false);
      }
      var rb = findRetryButton();
      if (!rb) {
        st.phase = 'done';
        state.lastAction = '答错但未找到重新作答入口';
        return Promise.resolve(false);
      }
      rb.click();
      st.submitted = false;
      st.phase = 'retry';
      return sleep(900).then(function () { return attemptRoot(root, st); });
    }
    if (st.phase === 'submitted') {
      if (Date.now() - st.lastAt < 5000) return Promise.resolve(false);
      st.submitted = false;
      st.phase = 'retry';
    }
    return attemptRoot(root, st);
  }

  /** 整页提交：仅当每道题都已成功作答（或已判定正确）且开关打开 */
  function maybeSubmitPage() {
    if (!settings.autoSubmitPage || pageSubmitDone) return false;
    // 已点过提交、正等平台确认：不要重复点
    if (submitClickedAt && !submittedConfirmed()) {
      state.lastAction = '已提交，等待平台记录"已完成"…（' + submitGapMs() / 1000 + 's）';
      return false;
    }
    var groups = findQuestionGroups();
    if (!groups.length) return false;

    var blocked = false;
    groups.forEach(function (g) {
      var st = rootStates.get(g.root);
      if (!st) { blocked = true; return; }
      if (st.phase === 'selected' || st.phase === 'submitted') return;
      if (st.phase === 'done' && verdictOf(g.root) === 'right') return;
      blocked = true;
    });
    if (blocked) {
      state.lastAction = '尚有题目未成功作答，暂不自动提交';
      return false;
    }

    var btn = findSubmitButton();
    if (!btn) {
      state.lastAction = '全部题目已作答，但未找到整页提交按钮';
      return false;
    }
    btn.click();
    submitClickedAt = Date.now();
    lastPageSubmitAt = submitClickedAt;
    pageSubmitDone = false;   // 提交"是否被平台接受"需等结果页/超时确认，不能一点就算完成
    state.lastAction = '已点击整页提交，等待 ' + (submitGapMs() / 1000) + 's 让平台记录后再下一节';
    scheduleNextAfterSubmit();
    return true;
  }

  /** 本帧找不到下一节时，请其它帧（目录树通常在主 frame）代劳 */
  function askOtherFramesForNext() {
    try {
      chrome.runtime.sendMessage({ type: 'GOTO_NEXT' }, function () { void chrome.runtime.lastError; });
    } catch (e) { /* 非扩展环境 */ }
  }

  /** 提交后自动去下一节：轮询调用 ensureAdvance，由它统一处理"等间隔 + 等确认 + 跨帧代点" */
  function scheduleNextAfterSubmit() {
    if (!settings.autoNext) return;
    if (nextWatchTimer) return;
    var tries = 0;
    nextWatchTimer = setInterval(function () {
      tries += 1;
      if (tries > 40) {
        clearInterval(nextWatchTimer);
        nextWatchTimer = null;
        if (!pageSubmitDone) state.lastAction = '提交后等待超时，仍未确认提交结果（可手动点下一节）';
        return;
      }
      if (ensureAdvance()) {
        clearInterval(nextWatchTimer);
        nextWatchTimer = null;
      }
    }, 1000);
  }

  /** 结果页判定：出现"我的答案/正确答案/得分/提交成功"等说明平台已受理提交 */
  function resultsDetected() {
    var t = '';
    try { t = (document.body && document.body.innerText) || ''; } catch (e) { t = ''; }
    return /我的答案|正确答案|答案解析|回答正确|回答错误|作答正确|作答错误|本次得分|得分[:：]|成绩[:：]|提交成功|答题结果/.test(t);
  }

  /** 提交后要求的"冷却间隔"（秒）：留足时间让平台把任务点记为"已完成" */
  function submitGapMs() {
    var s = parseInt(settings.submitGap, 10);
    if (isNaN(s) || s < 0) s = 6;
    return s * 1000;
  }

  /** 是否已过冷却间隔 */
  function submitSettled() {
    if (!submitClickedAt) return false;
    return Date.now() - submitClickedAt >= submitGapMs();
  }

  /** 提交是否已被平台确认（结果页出现即确认；超时兜底，避免永久卡死） */
  function submittedConfirmed() {
    if (pageSubmitDone) return true;
    if (resultsDetected()) { pageSubmitDone = true; return true; }
    if (submitClickedAt && Date.now() - submitClickedAt > 15000) {
      pageSubmitDone = true;
      state.lastAction = '提交后 15s 内未见结果页，按已提交继续';
      return true;
    }
    return false;
  }

  /** 若页面已出现结果（例如用户手动提交过），补记提交时刻，以便同样走冷却间隔 */
  function noteSubmitted() {
    if (!submitClickedAt && resultsDetected()) submitClickedAt = Date.now();
  }

  /** 提交确认 + 冷却间隔都满足后，才把流程推到下一节。
      本帧找不到"下一节"按钮时，请持有该按钮的其它 frame 代点（学习通按钮常在别的 frame）。 */
  function ensureAdvance() {
    if (!settings.autoNext) return false;
    noteSubmitted();
    if (!submitClickedAt) return false;
    if (!submitSettled()) {
      state.lastAction = '提交后等待平台记录：还需 ' +
        Math.ceil((submitGapMs() - (Date.now() - submitClickedAt)) / 1000) + 's';
      return false;
    }
    if (!submittedConfirmed()) return false;
    var btn = findNextButton();
    if (btn) {
      if (Date.now() - lastAdvanceAt < 4000) return false;
      lastAdvanceAt = Date.now();
      btn.click();
      state.lastAction = '结果页自动进入下一节：' + textOf(btn);
      return true;
    }
    if (Date.now() - lastAskAt > 6000) {
      lastAskAt = Date.now();
      askOtherFramesForNext();
    }
    return false;
  }

  /** 自动作答跑完后若都已完成，也在后台补一次提交（不依赖用户点按钮） */
  function autoSubmitTick() {
    if (!settings.autoSubmitPage || pageSubmitDone) return;
    maybeSubmitPage();
  }

  function answerQuiz(force) {
    if (answering) return Promise.resolve({ ok: false, busy: true });
    var now = Date.now();
    if (!force && now - lastAnswerAt < 2500) return Promise.resolve({ ok: false, throttled: true });
    lastAnswerAt = now;
    answering = true;

    var groups = findQuestionGroups();
    var seq = Promise.resolve();
    var processed = 0;
    groups.forEach(function (g) {
      seq = seq.then(function () {
        return handleRoot(g.root).then(function (did) {
          if (did) processed += 1;
          return sleep(250);
        });
      });
    });

    return seq.then(function () {
      saveCache();
      if (!needsWork()) {
        // 作答完成后先停 800ms，让平台记上最后一次选择，再点提交（避免"选了就交"被判未完成）
        return sleep(800).then(function () {
          if (!maybeSubmitPage()) {
            var resume = findResumeButton();
            if (resume) { resume.click(); state.lastAction = '答题结束，恢复播放'; }
          }
          reportState();
          return { ok: true, answered: processed };
        });
      }
      reportState();
      return { ok: true, answered: processed };
    }).catch(function (e) {
      state.lastError = '答题流程异常：' + String((e && e.message) || e);
      return { ok: false, error: state.lastError };
    }).finally(function () { answering = false; });
  }

  /* ================= 诊断输出 ================= */

  function dumpQuestions() {
    var groups = findQuestionGroups();
    var lines = [];
    var isTop = true;
    try { isTop = window.top === window; } catch (e) { isTop = false; }
    lines.push('页面：' + location.href);
    lines.push('顶层帧：' + (isTop ? '是' : '否（子 frame）') + '｜视频：' + document.querySelectorAll('video').length + ' 个');
    lines.push('识别到题目：' + groups.length);
    lines.push('候选节点：.TiMu=' + document.querySelectorAll('.TiMu').length +
      ' .Zy_TItle=' + document.querySelectorAll('.Zy_TItle').length +
      ' .Zy_ulTop=' + document.querySelectorAll('.Zy_ulTop').length +
      ' li=' + document.querySelectorAll('li').length +
      ' input=' + document.querySelectorAll('input').length +
      ' video=' + document.querySelectorAll('video').length);
    groups.forEach(function (g, i) {
      var opts = collectOptions(g.root);
      var stem = getStem(g.root, opts);
      lines.push('---------- 第 ' + (i + 1) + ' 题 ----------');
      lines.push('容器：' + (g.root.tagName || '') + '.' + String(g.root.className || '').slice(0, 60));
      lines.push('题干[' + (validStem(stem) ? '有效' : '无效') + ']：' + stem.slice(0, 150));
      if (opts.length) {
        opts.forEach(function (o) {
          lines.push('  ' + o.letter + '. ' + o.text.slice(0, 50) +
            '｜选择器命中：' + (o.input ? 'input' : 'node') +
            '｜当前选中：' + (selectedState(o) ? '是' : '否'));
        });
      } else {
        lines.push('  填空题输入框：' + collectFillInputs(g.root).length + ' 个');
      }
    });
    var submit = findSubmitButton();
    lines.push('页面级提交按钮：' + (submit ? textOf(submit) : '无'));
    var nb = findNextButton();
    lines.push('下一节按钮：' + (nb
      ? (nb.tagName + ' class="' + String(nb.className || '').slice(0, 40) + '" 文本「' + textOf(nb) + '」')
      : '未找到（本帧）') + '｜本帧：' + (isTopFrame() ? '顶层' : '子帧'));
    lines.push('已提交标记：' + pageSubmitDone + '｜检测到结果页：' + resultsDetected());
    lines.push('最近动作：' + state.lastAction);
    if (state.lastError) lines.push('最近错误：' + state.lastError);

    var iframes = Array.prototype.slice.call(document.querySelectorAll('iframe'));
    lines.push('本帧 iframe 数量：' + iframes.length);
    if (isTop) {
      iframes.slice(0, 6).forEach(function (f) {
        lines.push('  iframe src=' + String(f.src || '(空)').slice(0, 120));
      });
    }

    if (!groups.length) {
      var cands = Array.prototype.slice.call(
        document.querySelectorAll('.TiMu, .Zy_TItle, .question, .subject, .ans-videoquiz, ul.Zy_ulTop')
      ).slice(0, 12);
      lines.push('未形成题目分组，候选元素（前 12 个）：');
      if (!cands.length) lines.push('  （页面上没有 .TiMu / .Zy_TItle / .question 等候选容器）');
      cands.forEach(function (el) {
        lines.push('  <' + (el.tagName || '') + ' class="' + String(el.className || '').slice(0, 40) + '">' +
          ' 选项候选=' + collectOptions(el).length +
          ' 输入框=' + collectFillInputs(el).length +
          ' 文本=' + String(el.innerText || '').replace(/\s+/g, ' ').slice(0, 50));
      });
    }
    return lines.join('\n');
  }

  /* ================= 设置与消息 ================= */

  function loadSettings() {
    try {
      chrome.storage.local.get(SETTINGS_KEY, function (data) {
        settings = Object.assign({}, DEFAULTS, (data && data[SETTINGS_KEY]) || {});
        applySpeed();
      });
    } catch (e) { /* 非扩展环境 */ }
  }

  function loadBank() {
    if (bankTried) return;
    bankTried = true;
    try {
      fetch(chrome.runtime.getURL('question_bank.json'))
        .then(function (r) { return r.json(); })
        .then(function (data) { bank = Array.isArray(data) ? data : []; })
        .catch(function () { bank = []; });
    } catch (e) { bank = []; }
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    if (msg.type === 'SETTINGS_UPDATED') {
      settings = Object.assign({}, DEFAULTS, msg.settings || {});
      applySpeed();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'GET_STATE') {
      sendResponse({
        ok: true,
        state: {
          answered: state.answered,
          lastAction: state.lastAction,
          lastError: state.lastError,
          speed: state.speed,
          hasVideo: videos().length > 0,
          url: location.href,
          bank: bank.length,
          aiCalls: state.aiCalls,
          cacheHits: state.cacheHits,
          questions: findQuestionGroups().length,
          submitted: pageSubmitDone,
          results: resultsDetected(),
          nextBtn: (function () {
            var b = findNextButton();
            return b ? (b.tagName + '.' + String(b.className || '').slice(0, 20)) : '';
          })()
        }
      });
      return;
    }
    if (msg.type === 'ACTION') {
      if (msg.action === 'APPLY_SPEED') { applySpeed(); sendResponse({ ok: true }); }
      else if (msg.action === 'ANSWER_NOW') {
        answerQuiz(true).then(function (r) { sendResponse(Object.assign({ ok: true }, r)); });
        return true;
      }
      else if (msg.action === 'DUMP') { sendResponse({ ok: true, dump: dumpQuestions() }); }
      else if (msg.action === 'NEXT_CHAPTER') { sendResponse({ ok: clickNextChapter() }); }
      else if (msg.action === 'SKIP_DIALOG') { skipDialogs(); sendResponse({ ok: true }); }
    }
  });

  /* ================= 启动 ================= */

  loadSettings();
  loadBank();
  loadCache();
  setInterval(tick, 2000);
  tick();

  var moTimer = null;
  try {
    new MutationObserver(function () {
      if (moTimer) return;
      moTimer = setTimeout(function () {
        moTimer = null;
        if (settings.autoAnswer && needsWork()) answerQuiz(false);
      }, 600);
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* 无 DOM 环境 */ }

  /* 供自动化测试导出 */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      norm: norm,
      tokensOf: tokensOf,
      letterAt: letterAt,
      cleanStem: cleanStem,
      validStem: validStem,
      stripOptionPrefix: stripOptionPrefix,
      buildPrompt: buildPrompt,
      parseModelAnswer: parseModelAnswer,
      resolveIndexes: resolveIndexes,
      indexesFromAnswer: indexesFromAnswer,
      lookupBank: lookupBank,
      collectOptions: collectOptions,
      collectFillInputs: collectFillInputs,
      getStem: getStem,
      findQuestionGroups: findQuestionGroups,
      selectedState: selectedState,
      clickOption: clickOption,
      verdictOf: verdictOf,
      findSubmitButton: findSubmitButton,
      findClickableByText: findClickableByText,
      findNextButton: findNextButton,
      clickNextChapter: clickNextChapter,
      ensureAdvance: ensureAdvance,
      findDialogs: findDialogs,
      classifyDialog: classifyDialog,
      pickDialogButton: pickDialogButton,
      skipDialogs: skipDialogs,
      checkChapterChange: checkChapterChange,
      dumpQuestions: dumpQuestions,
      answerQuiz: answerQuiz,
      maybeSubmitPage: maybeSubmitPage,
      autoSubmitTick: autoSubmitTick,
      state: state,
      settings: settings,
      __flags: function () { return { pageSubmitDone: pageSubmitDone, submitClickedAt: submitClickedAt }; },
      resultsDetected: resultsDetected,
      __resetDialogThrottle: function () { lastDialogActionAt = 0; lastAdvanceAt = 0; lastAskAt = 0; },
      __setSubmitted: function (v) { pageSubmitDone = !!v; if (!v) submitClickedAt = 0; return pageSubmitDone; },
      __simulateSubmit: function (agoMs) { submitClickedAt = Date.now() - (agoMs || 0); pageSubmitDone = false; return submitClickedAt; },
      __setSubmitGap: function (sec) { settings.submitGap = sec; return settings.submitGap; },
      __setSettings: function (s) { settings = Object.assign({}, DEFAULTS, s || {}); return settings; }
    };
  }
})();
