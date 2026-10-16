(function () {
  'use strict';

  var SETTINGS_KEY = 'cx_settings';
  var LLM_KEY = 'cx_llm';

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
    submitGap: 3
  };

  var PRESETS = {
    zhipu: {
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      model: 'glm-4-flash',
      hint: '智谱 GLM-4-Flash 免费，国内直连，速率约 5 次/分钟。Key 在 open.bigmodel.cn 控制台创建。'
    },
    openrouter: {
      baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'openrouter/free',
      hint: 'OpenRouter 免费额度：约 20 次/分钟、每日 50 次。模型名需带 :free，例如 openai/gpt-oss-120b:free；也可直接填 openrouter/free 由平台自动选免费模型。'
    },
    siliconflow: {
      baseUrl: 'https://api.siliconflow.cn/v1/chat/completions',
      model: 'Qwen/Qwen3-8B',
      hint: '硅基流动部分模型免费，模型名请在官网模型广场复制完整 ID。'
    },
    deepseek: {
      baseUrl: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-chat',
      hint: 'DeepSeek 为付费接口，价格低，答题准确率高。'
    },
    ollama: {
      baseUrl: 'http://127.0.0.1:11434/v1/chat/completions',
      model: 'qwen2.5:7b',
      hint: '本地 Ollama 免费，需先 `ollama pull qwen2.5:7b` 并保持 ollama serve 运行，API Key 留空。'
    },
    custom: null
  };

  function $(id) { return document.getElementById(id); }

  function setStatus(text) { $('status').textContent = text; }
  function setHint(text) { $('llmHint').textContent = text; }

  function setConn(on) {
    var dot = $('conn');
    dot.classList.toggle('on', !!on);
    dot.title = on ? '已连接当前页面' : '未连接（请刷新学习通页面）';
  }

  function activeTab() {
    return new Promise(function (resolve) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        resolve(tabs && tabs[0]);
      });
    });
  }

  function sendToTab(msg) {
    return activeTab().then(function (tab) {
      return new Promise(function (resolve) {
        if (!tab) { setStatus('没有可用标签页'); setConn(false); resolve({}); return; }
        chrome.tabs.sendMessage(tab.id, msg, function (resp) {
          if (chrome.runtime.lastError) {
            setStatus('页面脚本未加载：请打开学习通课程页并刷新一次。');
            setConn(false);
            resolve({});
            return;
          }
          setConn(true);
          resolve(resp || {});
        });
      });
    });
  }

  function loadSettings() {
    chrome.storage.local.get(SETTINGS_KEY, function (data) {
      var s = Object.assign({}, DEFAULTS, (data && data[SETTINGS_KEY]) || {});
      $('autoPlay').checked = !!s.autoPlay;
      $('mute').checked = !!s.mute;
      $('autoNext').checked = !!s.autoNext;
      $('autoAnswer').checked = !!s.autoAnswer;
      $('useAI').checked = s.useAI !== false;
      $('useBank').checked = !!s.useBank;
      $('fillInputs').checked = s.fillInputs !== false;
      $('skipDialog').checked = !!s.skipDialog;
      $('autoSubmitPage').checked = !!s.autoSubmitPage;
      $('submitGap').value = String(s.submitGap != null ? s.submitGap : 3);
      $('retry').value = String(s.retry | 0);
      markSpeed(s.speed);
    });
  }

  function loadLLM() {
    chrome.storage.local.get(LLM_KEY, function (data) {
      var c = (data && data[LLM_KEY]) || {};
      var provider = c.provider || 'zhipu';
      $('provider').value = provider;
      var preset = PRESETS[provider];
      $('baseUrl').value = c.baseUrl || (preset ? preset.baseUrl : '');
      $('model').value = c.model || (preset ? preset.model : '');
      $('apiKey').value = c.apiKey || '';
      if (preset && preset.hint) setHint(preset.hint);
    });
  }

  function markSpeed(speed) {
    var btns = document.querySelectorAll('#speedGrid button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', parseFloat(btns[i].getAttribute('data-speed')) === parseFloat(speed));
    }
  }

  function currentSpeed() {
    var active = document.querySelector('#speedGrid button.active');
    return active ? parseFloat(active.getAttribute('data-speed')) : 1;
  }

  function collectSettings() {
    return {
      autoPlay: $('autoPlay').checked,
      mute: $('mute').checked,
      speed: currentSpeed(),
      autoNext: $('autoNext').checked,
      autoAnswer: $('autoAnswer').checked,
      useAI: $('useAI').checked,
      useBank: $('useBank').checked,
      fillInputs: $('fillInputs').checked,
      skipDialog: $('skipDialog').checked,
      autoSubmitPage: $('autoSubmitPage').checked,
      submitGap: parseInt($('submitGap').value, 10) || 0,
      retry: parseInt($('retry').value, 10) || 0
    };
  }

  function saveSettings() {
    var s = collectSettings();
    return new Promise(function (resolve) {
      chrome.storage.local.set({ [SETTINGS_KEY]: s }, function () { resolve(s); });
    });
  }

  function saveLLM() {
    var cfg = {
      provider: $('provider').value,
      baseUrl: $('baseUrl').value.trim(),
      model: $('model').value.trim(),
      apiKey: $('apiKey').value.trim()
    };
    return new Promise(function (resolve) {
      chrome.storage.local.set({ [LLM_KEY]: cfg }, function () { resolve(cfg); });
    });
  }

  /** 跨 frame 聚合状态：由后台收集所有 frame 后取题目最多的那份 */
  function bestState() {
    return activeTab().then(function (tab) {
      if (!tab) return null;
      return new Promise(function (resolve) {
        chrome.runtime.sendMessage({ type: 'GET_BEST_STATE', tabId: tab.id }, function (resp) {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve((resp && resp.state) || null);
        });
      });
    });
  }

  function dumpAllFrames() {
    return activeTab().then(function (tab) {
      if (!tab) return {};
      return new Promise(function (resolve) {
        chrome.runtime.sendMessage({ type: 'DUMP_TAB', tabId: tab.id }, function (resp) {
          if (chrome.runtime.lastError) { resolve({}); return; }
          resolve(resp || {});
        });
      });
    });
  }

  function refreshState() {
    bestState().then(function (st) {
      if (st) { renderState(st); return; }
      sendToTab({ type: 'GET_STATE' }).then(function (resp) { renderState((resp && resp.state) || {}); });
    });
  }

  function renderState(st) {
    st = st || {};
    setStatus(
      '页面：' + (st.url || '-') +
      '\n检测到视频：' + (st.hasVideo ? '是' : '否') +
      '\n识别到题目：' + (st.questions | 0) +
      '\n当前倍速：' + (st.speed != null ? st.speed + 'x' : '-') +
      '\n已作答：' + (st.answered | 0) + ' 次（AI ' + (st.aiCalls | 0) + '，缓存 ' + (st.cacheHits | 0) + '）' +
      '\n已提交标记：' + (st.submitted ? '是' : '否') +
      '｜结果页：' + (st.results ? '是' : '否') +
      '｜下一节按钮：' + (st.nextBtn || '未找到') +
      '\n最近动作：' + (st.lastAction || '-') +
      (st.lastError ? '\n最近错误：' + st.lastError : '')
    );
  }

  document.querySelectorAll('#speedGrid button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      markSpeed(btn.getAttribute('data-speed'));
      saveSettings().then(function (s) {
        return sendToTab({ type: 'SETTINGS_UPDATED', settings: s });
      }).then(function () {
        return sendToTab({ type: 'ACTION', action: 'APPLY_SPEED' });
      }).then(function () {
        setStatus('已应用倍速 ' + currentSpeed() + 'x');
      });
    });
  });

  $('provider').addEventListener('change', function () {
    var preset = PRESETS[$('provider').value];
    if (!preset) { setHint('自定义：填写任意 OpenAI 兼容的 /chat/completions 地址。'); return; }
    $('baseUrl').value = preset.baseUrl;
    $('model').value = preset.model;
    setHint(preset.hint);
  });

  $('btnSaveLLM').addEventListener('click', function () {
    saveLLM().then(function (cfg) {
      setStatus('模型设置已保存：' + cfg.model);
    });
  });

  $('btnTest').addEventListener('click', function () {
    setStatus('正在测试模型连接…');
    saveLLM().then(function () {
      chrome.runtime.sendMessage({ type: 'LLM_TEST' }, function (resp) {
        if (chrome.runtime.lastError) { setStatus('测试失败：' + chrome.runtime.lastError.message); return; }
        if (resp && resp.ok) setStatus('连接成功：' + (resp.model || '') + ' 返回「' + String(resp.answer).trim().slice(0, 40) + '」');
        else setStatus('连接失败：' + ((resp && resp.error) || '未知错误'));
      });
    });
  });

  $('btnSave').addEventListener('click', function () {
    saveSettings().then(function (s) {
      return sendToTab({ type: 'SETTINGS_UPDATED', settings: s });
    }).then(function () {
      setStatus('设置已保存');
    });
  });

  $('btnRefresh').addEventListener('click', refreshState);

  $('btnSpeedNow').addEventListener('click', function () {
    sendToTab({ type: 'ACTION', action: 'APPLY_SPEED' }).then(function () {
      setStatus('倍速已应用：' + currentSpeed() + 'x');
    });
  });

  $('btnAnswer').addEventListener('click', function () {
    setStatus('正在答题…');
    sendToTab({ type: 'ACTION', action: 'ANSWER_NOW' }).then(function (resp) {
      if (resp && resp.ok) setStatus('本次已处理题目数：' + (resp.answered | 0));
      else setStatus('答题未执行：' + ((resp && (resp.error || (resp.busy ? '当前正在答题中' : '已限流，稍后重试'))) || '未知原因'));
      refreshState();
    });
  });

  $('btnNext').addEventListener('click', function () {
    sendToTab({ type: 'ACTION', action: 'NEXT_CHAPTER' }).then(function (resp) {
      setStatus(resp.ok ? '已触发下一节' : '未找到下一节入口');
    });
  });

  $('btnDump').addEventListener('click', function () {
    $('dumpBox').value = '正在解析…';
    dumpAllFrames().then(function (resp) {
      if (resp && resp.dump) {
        $('dumpBox').value = resp.dump;
        setStatus('诊断完成：扫描 ' + (resp.frames | 0) + ' 个 frame，最多识别到 ' + (resp.questions | 0) + ' 道题');
      } else {
        $('dumpBox').value = '未获取到任何 frame 的解析结果。\n' +
          '1) 确认已在 edge://extensions 点了「重新加载」\n' +
          '2) 然后 Ctrl+F5 刷新当前学习通页面（旧页面不会自动换脚本）\n' +
          '3) 再点一次「诊断题目」';
        setStatus('诊断失败：未收到页面脚本响应');
      }
    });
  });

  try {
    var ver = chrome.runtime.getManifest().version;
    if ($('ver')) $('ver').textContent = 'v' + ver;
  } catch (e) { /* 非扩展环境 */ }

  loadSettings();
  loadLLM();
  refreshState();
})();
