# 学习通刷课助手（Chaoxing Auto Helper）

超星学习通（chaoxing.com）课程的浏览器辅助工具集，主体是一个 **Edge / Chrome Manifest V3 扩展**：
自动播放、一键倍速、接入大模型自动答题、自动提交、自动翻页，并可跨章节连续运行。

> ⚠️ 仅用于**个人学习效率**用途。请遵守所在学校/平台的规章制度与课程要求。

## 仓库结构

```
chaoxing-extension/            浏览器扩展（主体）
  manifest.json                MV3 清单
  content.js                   视频控制 + 题目解析 + 答题状态机 + 弹窗处理 + 自动翻页
  background.js                大模型调用代理 + 跨帧状态聚合
  popup.html / popup.css / popup.js   工具弹窗：倍速、一键操作、模型配置、诊断
  question_bank.json           本地题库（默认关闭，可作兜底）
  test_core.js                 纯函数测试（41 项）
  test_dom.js                  jsdom 页面级测试（57 项）
  test_background.js           后台与跨帧测试（26 项）
  README.md                    扩展详细说明（工作流、修复记录、FAQ）
study_helper.py                命令行题库工具：导入 / 检索 / 练习 / 错题记录
question_bank.example.json     题库格式示例
README.txt                     study_helper.py 使用说明
```

## 安全说明（重要）

- **本仓库不含任何 API Key**。所有密钥只保存在你本机浏览器的 `chrome.storage.local`，不会写入代码、不会上传。
- 已通过 `.gitignore` 排除：`*.pem`（扩展签名私钥）、`*.crx`（构建产物）、`.env`、`node_modules/`、`.workbuddy/`、`wrong_answers.json` 等。
- 如果你曾把 Key 写进过任何被提交的文件，请立刻到服务商控制台**吊销并重建**该 Key。

## 安装扩展

1. 打开 `edge://extensions`（或 Chrome 的 `chrome://extensions`），开启「开发人员模式」。
2. 点「加载解压缩的扩展」，选择 `chaoxing-extension/` 目录。
3. 打开扩展弹窗，在「答题模型」里选择服务商、填自己的 API Key，点「保存模型设置」→「测试连接」。
4. 进入学习通课程页，按需勾选自动功能即可。

支持的模型（任意 OpenAI 兼容 `/chat/completions` 接口）：
智谱 GLM-4-Flash（免费）、OpenRouter（`:free` 模型）、硅基流动、DeepSeek、本地 Ollama（可留空 Key）。

## 运行测试

```bash
node chaoxing-extension/test_core.js
node chaoxing-extension/test_background.js
NODE_PATH=<node_modules 路径> node chaoxing-extension/test_dom.js   # 需要 jsdom
```

合计 124 项断言。

## 命令行题库工具

见 `README.txt`。示例：

```bash
python study_helper.py search question_bank.example.json "HTTP 默认端口"
python study_helper.py quiz   question_bank.example.json --count 10
python study_helper.py quiz   question_bank.example.json --wrong-only
```

## 许可

仅个人学习使用，风险自负。
