学习通题库辅助脚本

文件：
- study_helper.py：题目导入、检索、练习、错题记录
- question_bank.example.json：题库格式示例
- wrong_answers.json：运行 quiz 后自动生成

使用：
1. 复制示例题库为自己的 JSON，按 question/answer/options/type/explanation 填写。
2. 检索答案：
   python study_helper.py search question_bank.example.json "HTTP 默认端口"
3. 交互练习：
   python study_helper.py quiz question_bank.example.json --count 10
4. 只练错题：
   python study_helper.py quiz question_bank.example.json --wrong-only
5. 查看统计：
   python study_helper.py stats question_bank.example.json

CSV 也支持，表头可用：question,answer,options,type,explanation。
options 多个选项用 |、分号或换行分隔。选择题答案可填写 A、B、A,C，也可直接输入选项文本；程序会统一处理中英文标点。

说明：该工具只处理本地题库和复习记录，不登录学习通，不自动提交作业或考试。
