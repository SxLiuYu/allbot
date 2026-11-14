#!/usr/bin/env python3
"""给 values-* 的 strings_calls.xml 补 calls_missing_* 这一组文案。

用法（在 mobile/ 目录）：
    python3 ../scripts/add-missing-call-strings.py

为什么单独一个脚本而不是手改：同一组 8 条要写进 7 个语言目录，手改十几次
容易漏一个键或把占位符 `%1$s` 写错。这个脚本可重复运行（已存在的键跳过）。
"""
import os
import re
import sys

# key -> {语言目录: 译文}
# 参考 values/strings_calls.xml 的英文原文：
#   calls_verify_blocked       Finish these first: %1$s.
#   calls_missing_disabled     AI calling is off
#   calls_missing_phone_permission  phone permission
#   calls_missing_notifications     call notifications
#   calls_missing_credentials       Volcengine credentials
#   calls_missing_audio             call audio path
#   calls_missing_helper            phone helper
#   calls_missing_join              ", "
TRANSLATIONS = {
    "values-ja": {
        "calls_verify_blocked": "先に次を済ませてください: %1$s。",
        "calls_missing_disabled": "AI 通話がオフになっています",
        "calls_missing_phone_permission": "電話の権限",
        "calls_missing_notifications": "通話の通知",
        "calls_missing_credentials": "Volcengine の認証情報",
        "calls_missing_audio": "通話音声の経路",
        "calls_missing_helper": "電話ヘルパー",
        "calls_missing_join": "、",
    },
    "values-ko": {
        "calls_verify_blocked": "먼저 다음을 완료하세요: %1$s.",
        "calls_missing_disabled": "AI 통화가 꺼져 있습니다",
        "calls_missing_phone_permission": "전화 권한",
        "calls_missing_notifications": "통화 알림",
        "calls_missing_credentials": "Volcengine 인증 정보",
        "calls_missing_audio": "통화 오디오 경로",
        "calls_missing_helper": "전화 도우미",
        "calls_missing_join": ", ",
    },
    "values-es": {
        "calls_verify_blocked": "Primero completa esto: %1$s.",
        "calls_missing_disabled": "Las llamadas con IA están desactivadas",
        "calls_missing_phone_permission": "permiso de teléfono",
        "calls_missing_notifications": "notificaciones de llamada",
        "calls_missing_credentials": "credenciales de Volcengine",
        "calls_missing_audio": "ruta de audio de la llamada",
        "calls_missing_helper": "asistente de teléfono",
        "calls_missing_join": ", ",
    },
    "values-pt": {
        "calls_verify_blocked": "Conclua isto primeiro: %1$s.",
        "calls_missing_disabled": "As chamadas com IA estão desligadas",
        "calls_missing_phone_permission": "permissão de telefone",
        "calls_missing_notifications": "notificações de chamada",
        "calls_missing_credentials": "credenciais do Volcengine",
        "calls_missing_audio": "caminho de áudio da chamada",
        "calls_missing_helper": "assistente de telefone",
        "calls_missing_join": ", ",
    },
    "values-ru": {
        "calls_verify_blocked": "Сначала выполните это: %1$s.",
        "calls_missing_disabled": "ИИ-звонки выключены",
        "calls_missing_phone_permission": "разрешение на телефон",
        "calls_missing_notifications": "уведомления о звонках",
        "calls_missing_credentials": "учётные данные Volcengine",
        "calls_missing_audio": "путь аудио звонка",
        "calls_missing_helper": "помощник телефона",
        "calls_missing_join": ", ",
    },
    "values-in": {
        "calls_verify_blocked": "Selesaikan ini dulu: %1$s.",
        "calls_missing_disabled": "Panggilan AI dinonaktifkan",
        "calls_missing_phone_permission": "izin telepon",
        "calls_missing_notifications": "notifikasi panggilan",
        "calls_missing_credentials": "kredensial Volcengine",
        "calls_missing_audio": "jalur audio panggilan",
        "calls_missing_helper": "asisten telepon",
        "calls_missing_join": ", ",
    },
    "values-b+zh+Hant": {
        "calls_verify_blocked": "請先完成：%1$s。",
        "calls_missing_disabled": "AI 通話已關閉",
        "calls_missing_phone_permission": "電話權限",
        "calls_missing_notifications": "通話通知",
        "calls_missing_credentials": "Volcengine 憑證",
        "calls_missing_audio": "通話音訊路徑",
        "calls_missing_helper": "電話助手",
        "calls_missing_join": "、",
    },
}

RES_DIR = os.path.join("app", "src", "main", "res")
CLOSING = "</resources>"


def escape(text: str) -> str:
    # XML 里 &、<、> 要转义；引号在文本节点里不必转义
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def main() -> int:
    if not os.path.isdir(RES_DIR):
        print(f"找不到 {RES_DIR}；请在 mobile/ 目录下运行", file=sys.stderr)
        return 1
    changed = 0
    for folder, entries in TRANSLATIONS.items():
        path = os.path.join(RES_DIR, folder, "strings_calls.xml")
        if not os.path.isfile(path):
            print(f"跳过（文件不存在）: {path}")
            continue
        with open(path, encoding="utf-8") as f:
            src = f.read()
        missing = {k: v for k, v in entries.items()
                   if not re.search(rf'name="{re.escape(k)}"', src)}
        if not missing:
            print(f"已完整，跳过: {folder}")
            continue
        lines = "".join(
            f'    <string name="{k}">{escape(v)}</string>\n'
            for k, v in missing.items()
        )
        idx = src.rfind(CLOSING)
        if idx < 0:
            print(f"{path} 里没有 {CLOSING}，跳过", file=sys.stderr)
            continue
        out = src[:idx] + lines + src[idx:]
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(out)
        print(f"{folder}: 补了 {len(missing)} 条")
        changed += 1
    print(f"共更新 {changed} 个文件")
    return 0


if __name__ == "__main__":
    sys.exit(main())
