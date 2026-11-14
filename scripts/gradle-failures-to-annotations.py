#!/usr/bin/env python3
"""把 gradle 的 JUnit 结果转成 GitHub Actions 的 annotation。

为什么需要这个：CI 里 `:core:test` / `:app:testDebugUnitTest` 红了以后，
job 日志需要一个有 admin 权限的 token 才能通过 API 读（匿名请求返回
`403 Must have admin rights`）。check run 的 `annotations` 匿名可读，
所以把失败用例和断言消息发成 annotation，就能直接拉到「哪个用例、为什么」。

gradle 的 stdout 只有用例名（`FooTest > bar FAILED`），断言里的 message
在 `build/test-results/*/TEST-*.xml` 的 `<failure message=...>` 里——那个才
是能修的东西。

GitHub 每个 step 最多收 10 条 annotation，所以默认只发前 8 条，并打印总数。

用法（在仓库根目录）：
    python3 scripts/gradle-failures-to-annotations.py [mobile]
"""
import glob
import os
import sys
import xml.etree.ElementTree as ET

# 10 条上限里留 2 条余量给「总数」和可能的兜底输出
MAX_ANNOTATIONS = 8


def collect(root: str) -> list[tuple[str, str]]:
    """扫 root 下所有模块的 JUnit XML，返回 [(用例名, 断言消息)]。"""
    pattern = os.path.join(root, "*/build/test-results/*/*.xml")
    found: list[tuple[str, str]] = []
    for path in sorted(glob.glob(pattern)):
        try:
            tree = ET.parse(path)
        except Exception:
            # 半截写入的 XML 不该让整个步骤挂掉
            continue
        for case in tree.iter("testcase"):
            failures = list(case.iter("failure")) + list(case.iter("error"))
            if not failures:
                continue
            name = f"{case.get('classname', '')}.{case.get('name', '')}"
            fail = failures[0]
            msg = (fail.get("message") or fail.text or "").strip()
            # annotation 的 message 不能带换行，`%` 在 workflow command 里要转义
            msg = " ".join(msg.split()).replace("%", "%25")
            found.append((name, msg[:700]))
    return found


def main() -> int:
    root = sys.argv[1] if len(sys.argv) > 1 else "mobile"
    found = collect(root)
    for name, msg in found[:MAX_ANNOTATIONS]:
        # 文件名前缀让 GitHub 把 annotation 归到某个文件下，否则只挂在 check run 上
        print(f"::error title=assert {name}::{msg}")
    print(f"# total failures: {len(found)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
