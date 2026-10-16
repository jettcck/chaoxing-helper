#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""学习通题库辅助工具：本地导入、检索、练习和错题复习。

题库格式：JSON 数组，每项包含 question、answer，可选 options、type、explanation。
支持 JSON/CSV 导入；不会登录学习通、抓取账号数据或自动提交作业/考试。
"""
from __future__ import annotations

import argparse
import csv
import json
import random
import re
import sys
import unicodedata
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable

DEFAULT_DB = Path(__file__).with_name("question_bank.json")
DEFAULT_WRONG = Path(__file__).with_name("wrong_answers.json")


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def key_text(value: Any) -> str:
    return re.sub(r"[^\w\u4e00-\u9fff]", "", clean_text(value)).lower()


def answer_key(value: Any, options: list[str] | None = None) -> str:
    """统一答案格式，支持 A,B / Ａ、Ｂ / 选项文本等输入。"""
    text = unicodedata.normalize("NFKC", clean_text(value)).translate(str.maketrans("，；、|", ",,,,"))
    parts = [clean_text(x) for x in re.split(r"[,;]+", text) if clean_text(x)]
    labels: list[str] = []
    for part in parts:
        match = re.fullmatch(r"[（(]?\s*([A-Za-zＡ-Ｚａ-ｚ])\s*[）)]?", part)
        if match:
            labels.append(match.group(1).upper())
            continue
        if options:
            normalized = key_text(part)
            for index, option in enumerate(options):
                if normalized == key_text(option):
                    labels.append(chr(ord("A") + index))
                    break
            else:
                labels.append(normalized)
        else:
            labels.append(key_text(part))
    return ",".join(sorted(set(labels)))


def answers_match(typed: str, expected: str, options: list[str]) -> bool:
    return answer_key(typed, options) == answer_key(expected, options)


@dataclass
class Question:
    question: str
    answer: str
    options: list[str] = field(default_factory=list)
    type: str = ""
    explanation: str = ""
    source: str = ""

    @classmethod
    def from_dict(cls, item: dict[str, Any], source: str = "") -> "Question":
        options = item.get("options", [])
        if isinstance(options, str):
            options = [x.strip() for x in re.split(r"[|;；\n]", options) if x.strip()]
        return cls(
            question=clean_text(item.get("question") or item.get("题目") or item.get("title")),
            answer=clean_text(item.get("answer") or item.get("答案") or item.get("correct")),
            options=[clean_text(x) for x in options],
            type=clean_text(item.get("type") or item.get("题型")),
            explanation=clean_text(item.get("explanation") or item.get("解析") or item.get("analysis")),
            source=source or clean_text(item.get("source") or item.get("来源")),
        )

    def valid(self) -> bool:
        return bool(self.question and self.answer)


def load_records(path: Path) -> list[Question]:
    if not path.exists():
        raise FileNotFoundError(f"题库文件不存在：{path}")
    if path.suffix.lower() == ".csv":
        with path.open("r", encoding="utf-8-sig", newline="") as f:
            return [Question.from_dict(row, str(path)) for row in csv.DictReader(f)]
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict):
        data = data.get("questions") or data.get("题目") or []
    return [Question.from_dict(x, str(path)) for x in data if isinstance(x, dict)]


def save_records(path: Path, questions: Iterable[Question]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump([asdict(q) for q in questions], f, ensure_ascii=False, indent=2)


def merge_bank(files: list[Path]) -> list[Question]:
    result: dict[str, Question] = {}
    for path in files:
        for q in load_records(path):
            if q.valid():
                result[key_text(q.question)] = q
    return list(result.values())


def search(questions: list[Question], query: str, limit: int = 10) -> list[Question]:
    q = key_text(query)
    if not q:
        return []
    scored: list[tuple[int, Question]] = []
    for item in questions:
        text = key_text(item.question)
        score = 0
        if q == text:
            score = 1000
        elif q in text:
            score = 700 + min(len(q), 100)
        else:
            overlap = sum(1 for token in re.findall(r"[\u4e00-\u9fff]|[a-z0-9]+", q) if token in text)
            score = overlap * 10
        if score:
            scored.append((score, item))
    return [item for _, item in sorted(scored, key=lambda x: (-x[0], len(x[1].question)))[:limit]]


def load_wrong(path: Path) -> set[str]:
    if not path.exists():
        return set()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return {key_text(x) for x in data if isinstance(x, str)}
    except (OSError, json.JSONDecodeError):
        return set()


def save_wrong(path: Path, wrong: set[str]) -> None:
    path.write_text(json.dumps(sorted(wrong), ensure_ascii=False, indent=2), encoding="utf-8")


def print_question(q: Question, index: int | None = None, reveal: bool = True) -> None:
    prefix = f"[{index}] " if index is not None else ""
    print(f"{prefix}{q.question}")
    if q.type:
        print(f"题型：{q.type}")
    if q.options:
        print("选项：" + " | ".join(q.options))
    if reveal:
        print(f"答案：{q.answer}")
        if q.explanation:
            print(f"解析：{q.explanation}")
    if q.source:
        print(f"来源：{q.source}")


def cmd_search(args: argparse.Namespace) -> int:
    bank = merge_bank([Path(x) for x in args.files])
    hits = search(bank, args.query, args.limit)
    print(f"题库：{len(bank)} 题，匹配：{len(hits)} 题")
    for i, q in enumerate(hits, 1):
        print_question(q, i)
        print("-" * 50)
    return 0


def cmd_quiz(args: argparse.Namespace) -> int:
    bank = merge_bank([Path(x) for x in args.files])
    wrong_path = Path(args.wrong_file)
    wrong = load_wrong(wrong_path) if args.wrong_only else set()
    pool = [q for q in bank if not wrong or key_text(q.question) in wrong]
    if not pool:
        print("没有可练习的题目。")
        return 1
    random.shuffle(pool)
    score = 0
    for number, q in enumerate(pool[: args.count], 1):
        print(f"\n第 {number} 题/{min(args.count, len(pool))}")
        print_question(q, reveal=False)
        typed = input("你的答案（输入 q 退出）：").strip()
        if typed.lower() == "q":
            break
        if answers_match(typed, q.answer, q.options):
            print("回答正确")
            score += 1
        else:
            print(f"回答不匹配，标准答案：{q.answer}")
            wrong.add(key_text(q.question))
        if q.explanation:
            print(f"解析：{q.explanation}")
    save_wrong(wrong_path, wrong)
    print(f"\n本轮得分：{score}/{min(args.count, len(pool))}；错题已保存：{wrong_path}")
    return 0


def cmd_stats(args: argparse.Namespace) -> int:
    bank = merge_bank([Path(x) for x in args.files])
    wrong = load_wrong(Path(args.wrong_file))
    types: dict[str, int] = {}
    for q in bank:
        types[q.type or "未分类"] = types.get(q.type or "未分类", 0) + 1
    print(f"题目总数：{len(bank)}")
    print(f"错题数：{sum(key_text(q.question) in wrong for q in bank)}")
    print("题型分布：")
    for kind, count in sorted(types.items()):
        print(f"  {kind}: {count}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="学习通题库本地检索与错题复习工具")
    sub = p.add_subparsers(dest="command", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("files", nargs="+", help="JSON 或 CSV 题库文件")
    s = sub.add_parser("search", parents=[common], help="按题干检索答案")
    s.add_argument("query")
    s.add_argument("-n", "--limit", type=int, default=10)
    s.set_defaults(func=cmd_search)
    q = sub.add_parser("quiz", parents=[common], help="交互式练习并记录错题")
    q.add_argument("-n", "--count", type=int, default=10)
    q.add_argument("--wrong-only", action="store_true")
    q.add_argument("--wrong-file", default=str(DEFAULT_WRONG))
    q.set_defaults(func=cmd_quiz)
    t = sub.add_parser("stats", parents=[common], help="查看题库统计")
    t.add_argument("--wrong-file", default=str(DEFAULT_WRONG))
    t.set_defaults(func=cmd_stats)
    return p


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
        return args.func(args)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
