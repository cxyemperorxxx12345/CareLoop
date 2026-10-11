#!/usr/bin/env python3
"""
Generate speech via MiniMax T2A V2 and save the audio to disk.
Audio URL or hex payload handling stays inside this script.

Usage:
    python3 synthesize_speech.py --text "你好" --output /path/to/audio.mp3

Environment:
    INTEGRATIONS_API_KEY - platform-injected API key (required)

Exit codes:
    0 - success, prints JSON: {"file": "...", "audio_length": ..., "usage_characters": ...}
    1 - API or argument error
"""

import os
import sys
import json
import argparse
from pathlib import Path
import urllib.request
import urllib.error


T2A_URL = "https://app-ezvlp6ds1hqa-api-DLEO7Bj0lORa-gateway.miaoda.online/v1/t2a_v2"


def parse_args():
    """解析命令行参数。"""
    p = argparse.ArgumentParser()
    p.add_argument("--text")
    p.add_argument("--list-voices", action="store_true", help="列出本技能指定音色ID、名称与语言")
    p.add_argument("--output")
    p.add_argument("--model", default="speech-02-hd")
    p.add_argument("--voice-id", default="male-qn-qingse")
    p.add_argument("--speed", type=float, default=1.0)
    p.add_argument("--vol", type=float, default=1.0)
    p.add_argument("--pitch", type=int, default=0)
    p.add_argument("--format", default="mp3", choices=["mp3", "wav", "flac", "pcm"])
    p.add_argument("--output-format", default="url", choices=["url", "hex"])
    return p.parse_args()


def post_json(api_key: str, payload_obj: dict) -> dict:
    """调用上游接口并返回响应。"""
    payload = json.dumps(payload_obj).encode()
    req = urllib.request.Request(
        T2A_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-Gateway-Authorization": f"Bearer {api_key}",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        print(f"HTTP {e.code}: {body}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Network error: {e}", file=sys.stderr)
        sys.exit(1)


def download(url: str, output: str):
    """下载文件并保存到本地路径。"""
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req) as resp, open(output, "wb") as f:
        f.write(resp.read())


def save_hex(hex_audio: str, output: str):
    """将十六进制音频数据解码并保存为本地文件。"""
    with open(output, "wb") as f:
        f.write(bytes.fromhex(hex_audio))


def main():
    """入口：合成语音并保存音频文件。"""
    args = parse_args()
    voices = json.loads((Path(__file__).resolve().parents[1] / "assets/system-voices.json").read_text())
    if args.list_voices:
        print(json.dumps(voices, ensure_ascii=False))
        return
    if not args.text or not args.output:
        raise ValueError("--text and --output are required")
    if args.voice_id not in {v["voice_id"] for v in voices}:
        raise ValueError("Unsupported voice_id; use --list-voices and select from this skill fixed catalog. Custom voices are not supported.")
    if not (0 < len(args.text) < 10000):
        raise ValueError("text must contain 1-9999 characters")
    if not (0.5 <= args.speed <= 2 and 0 < args.vol <= 10 and -12 <= args.pitch <= 12):
        raise ValueError("Invalid speed, vol or pitch range")
    api_key = os.environ.get("INTEGRATIONS_API_KEY", "")
    if not api_key:
        print("INTEGRATIONS_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    payload = {
        "model": args.model,
        "text": args.text,
        "stream": False,
        "output_format": args.output_format,
        "voice_setting": {
            "voice_id": args.voice_id,
            "speed": args.speed,
            "vol": args.vol,
            "pitch": args.pitch,
        },
        "audio_setting": {"format": args.format},
    }

    d = post_json(api_key, payload)
    base_resp = d.get("base_resp", {})
    if base_resp.get("status_code") not in (None, 0):
        print(f"API error: {json.dumps(d, ensure_ascii=False)}", file=sys.stderr)
        sys.exit(1)

    data = d.get("data", {})
    audio = data.get("audio")
    if not audio:
        print(f"响应中未找到音频: {json.dumps(d, ensure_ascii=False)}", file=sys.stderr)
        sys.exit(1)

    if args.output_format == "url":
        download(audio, args.output)
        url = audio
    else:
        save_hex(audio, args.output)
        url = None

    extra_info = d.get("extra_info", {})
    print(json.dumps({
        "file": args.output,
        "url": url,
        "audio_length": extra_info.get("audio_length"),
        "usage_characters": extra_info.get("usage_characters"),
        "base_resp": base_resp,
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except ValueError as e:
        print(json.dumps({"error":str(e),"stage":"input_validation"},ensure_ascii=False),file=sys.stderr)
        sys.exit(1)
