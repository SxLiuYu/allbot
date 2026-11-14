#!/usr/bin/env python3
"""把 pytest 的 JUnit XML 转成 GitHub Actions annotation。

为什么需要：CI 里 pytest 红了以后，job 日志需要一个有 admin 权限的 token 才能
通过 API 读（匿名请求返回 `403 Must have admin rights`）。check run 的
`annotations` 匿名可读，所以把失败用例和断言消息发成 annotation，就能直接拉到
「哪个用例、为什么」。

pytest 的 `-q` 会把进度点拼在 FAILED 行前面，`^FAILED` 那种 grep 匹配不到；
JUnit XML 里的 <failure> 才是干净的来源，还带断言消息。

GitHub 每个 step 最多收 10 条 annotation，所以默认只发前 6 条并打印总数，
给汇总行留位置。

用法：
    python3 scripts/pytest-junit-to-annotations.py /tmp/voice-junit.xml
"""
import sys
import xml.etree.ElementTree as ET

# 10 条上限里留 4 条给调用方的汇总/兜底输出
MAX_ANNOTATIONS = 6


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: pytest-junit-to-annotations.py <junit.xml>", file=sys.stderr)
        return 2
    try:
        tree = ET.parse(sys.argv[1])
    except Exception as exc:  # noqa: BLE001 打不出 XML 时不该让整步挂掉
        print(f"::error title=pytest::无法解析 {sys.argv[1]}: {exc}")
        return 0

    total = 0
    for case in tree.iter("testcase"):
        failures = list(case.iter("failure")) + list(case.iter("error"))
        if not failures:
            continue
        total += 1
        if total > MAX_ANNOTATIONS:
            continue
        name = f"{case.get('classname', '')}::{case.get('name', '')}"
        first = failures[0]
        # annotation 的 message 不能带换行，`%` 在 workflow command 里要转义
        msg = (first.get("message") or first.text or "").strip()
        msg = " ".join(msg.split()).replace("%", "%25")[:600]
        print(f"::error title={name}::{msg}")

    print(f"# failed cases: {total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
