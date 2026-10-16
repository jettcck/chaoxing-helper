/* Node 桩测试：验证 content.js 的纯函数（题库检索、答案解析、选项映射） */
'use strict';

global.chrome = {
  runtime: {
    onMessage: { addListener() {} },
    getURL: (p) => p,
    sendMessage(msg, cb) { if (cb) cb({ ok: false, error: 'test-stub' }); },
    lastError: null
  },
  storage: {
    local: {
      get(k, cb) { cb({}); },
      set(o, cb) { if (cb) cb(); }
    }
  }
};
global.document = {
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener() {},
  documentElement: {}
};
global.getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
global.MutationObserver = class { observe() {} };
global.fetch = () => Promise.reject(new Error('no fetch in test'));
global.setInterval = () => 0;
global.HTMLInputElement = class {};
global.HTMLTextAreaElement = class {};

const mod = require('./content.js');
const {
  norm, stripOptionPrefix, buildPrompt, parseModelAnswer,
  resolveIndexes, indexesFromAnswer, lookupBank, letterAt, cleanStem, validStem
} = mod;
const bank = require('./question_bank.json');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name); }
}

/* --- norm --- */
check('norm 去标点', norm('HTTP 的默认端口是多少？') === 'http的默认端口是多少');
check('norm 全半角一致', norm('Ａ，Ｂ') === norm('A,B'));

/* --- letterAt --- */
check('letterAt 基本映射', letterAt(0) === 'A' && letterAt(25) === 'Z');
check('letterAt 越界返回空', letterAt(26) === '');

/* --- stripOptionPrefix --- */
check('去前缀 A.', stripOptionPrefix('A. 北京').text === '北京' && stripOptionPrefix('A. 北京').letter === 'A');
check('去前缀 （B）', stripOptionPrefix('（B）上海').letter === 'B');
check('去前缀 B、', stripOptionPrefix('B、广州').text === '广州');
check('无前缀保留原文', stripOptionPrefix('普通选项文本').letter === '' && stripOptionPrefix('普通选项文本').text === '普通选项文本');

/* --- buildPrompt --- */
const prompt = buildPrompt('中国的首都是？', ['北京', '上海'], '');
check('提示词含题干', prompt.indexOf('中国的首都是？') !== -1);
check('提示词含字母化选项', prompt.indexOf('A. 北京') !== -1 && prompt.indexOf('B. 上海') !== -1);
check('提示词含 JSON 输出要求', prompt.indexOf('{"answer":"A"}') !== -1);
const prompt2 = buildPrompt('中国的首都是？', ['北京', '上海'], 'A');
check('提示词含错误反馈', prompt2.indexOf('判定为错误') !== -1);

/* --- parseModelAnswer --- */
check('解析纯 JSON', parseModelAnswer('{"answer":"A"}') === 'A');
check('解析带解释的 JSON', parseModelAnswer('这是我的判断：{"answer":"A,C"} 完毕') === 'A,C');
check('解析代码块', parseModelAnswer('```json\n{"answer":"B"}\n```') === 'B');
check('解析纯字母列表', parseModelAnswer('A,B') === 'A,B');
check('解析数组答案', parseModelAnswer('{"answer":["A","C"]}') === 'A,C');
check('解析填空文本', parseModelAnswer('{"answer":"比特"}') === '比特');
check('解析全角字母答案', parseModelAnswer('{"answer":"Ａ，Ｃ"}') === 'A,C');
check('空输入返回空', parseModelAnswer('') === '');

/* --- resolveIndexes --- */
const texts = ['北京', '上海', '广州', '深圳'];
check('字母映射单选', JSON.stringify(resolveIndexes('B', texts)) === '[1]');
check('字母映射多选', JSON.stringify(resolveIndexes('A,C', texts)) === '[0,2]');
check('全角字母多选', JSON.stringify(resolveIndexes('Ａ，Ｃ', texts)) === '[0,2]');
check('文本映射', JSON.stringify(resolveIndexes('广州', texts)) === '[2]');
check('判断题"正确"映射', JSON.stringify(resolveIndexes('正确', ['正确', '错误'])) === '[0]');
check('判断题"错误"映射', JSON.stringify(resolveIndexes('错误', ['正确', '错误'])) === '[1]');
check('越界字母被忽略', JSON.stringify(resolveIndexes('Z', texts)) === '[]');

/* --- indexesFromAnswer（带选项前缀） --- */
const optsWithPrefix = [
  { letter: 'A', text: '北京' },
  { letter: 'B', text: '上海' },
  { letter: 'C', text: '广州' }
];
check('字母答案按下标映射', JSON.stringify(indexesFromAnswer('C', optsWithPrefix)) === '[2]');
check('文本答案映射', JSON.stringify(indexesFromAnswer('上海', optsWithPrefix)) === '[1]');

/* --- 题干清洗与有效性（v1.3.0 新增） --- */
check('去题号前缀', cleanStem('1、中国的首都是？') === '中国的首都是？');
check('去题号加方括号', cleanStem('12【单选题】下列说法正确的是') === '【单选题】下列说法正确的是');
check('去分值行', cleanStem('题目内容(分值：20.0分)') === '题目内容');
check('题干有效：中文', validStem('中国的近代史是指哪一年开始') === true);
check('题干无效：纯数字', validStem('4') === false);
check('题干无效：空串', validStem('') === false);
check('题干有效：英文', validStem('HTTP default port') === true);

/* --- 选项前缀（含无分隔符写法） --- */
check('去前缀 A 空格文本', stripOptionPrefix('A 1840年').letter === 'A' && stripOptionPrefix('A 1840年').text === '1840年');
check('去前缀 A、文本', stripOptionPrefix('A、1840年').text === '1840年');

/* --- 题库兜底检索 --- */
check('题库精确匹配', lookupBank('HTTP 的默认端口是多少？', bank).answer === '80');
check('题库近似匹配', !!lookupBank('以下哪些属于常见编程语言', bank));
check('题库无匹配返回 null', lookupBank('量子纠缠的数学描述', bank) === null);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
