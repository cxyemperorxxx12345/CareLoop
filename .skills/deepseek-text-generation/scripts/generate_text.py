#!/usr/bin/env python3
"""JSON-mode task invocation; app streaming lives in assets/chat-runtime.mjs."""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ENDPOINT = "https://app-ezvlp6ds1hqa-api-ra5E8QRXA0wa-gateway.miaoda.online/v2/chat/completions"
MODEL = "deepseek-v4-pro-0813"

def emit(value):
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))

def main():
    parser = argparse.ArgumentParser(
        description="DeepSeek text generation via Miaoda gateway (JSON mode)",
        epilog="Environment: INTEGRATIONS_API_KEY; never log its value.",
    )
    parser.add_argument("--model", choices=[MODEL, "deepseek-v4.1-flash"], default=MODEL)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--system", default="You are a helpful assistant.")
    parser.add_argument("--endpoint", default=ENDPOINT)
    parser.add_argument("--max-tokens", type=int, default=4096)
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()
    key = os.environ.get("INTEGRATIONS_API_KEY")
    if not key:
        emit({"ok": False, "error": "missing_environment"})
        return 2
    endpoint = urllib.parse.urlsplit(args.endpoint)
    if "API_ID@" in args.endpoint:
        emit({"ok": False, "error": "missing_api_id"})
        return 2
    if (endpoint.scheme != "https" or endpoint.hostname != "app-ezvlp6ds1hqa-api-ra5E8QRXA0wa-gateway.miaoda.online"
            or not (endpoint.username or "").startswith("api-")
            or endpoint.path != "/v2/chat/completions" or endpoint.password
            or endpoint.query or endpoint.fragment):
        emit({"ok": False, "error": "invalid_gateway_endpoint"})
        return 2
    if not 128 <= args.max_tokens <= 16384 or not 1 <= args.timeout <= 300:
        emit({"ok": False, "error": "invalid_budget_or_timeout"})
        return 2
    payload = {
        "model": args.model,
        "messages": [{"role": "system", "content": args.system},
                     {"role": "user", "content": args.prompt}],
        "stream": False,
        "max_tokens": args.max_tokens,
        "thinking": {"type": "disabled"},
    }
    for attempt in range(4):
        req = urllib.request.Request(
            args.endpoint, data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json",
                     "X-Gateway-Authorization": "Bearer " + key},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=args.timeout) as response:
                if "application/json" not in response.headers.get("Content-Type", ""):
                    raise ValueError("unexpected_content_type")
                data = json.loads(response.read())
            if data.get("error") or data.get("code"):
                raise ValueError("upstream_error")
            choice = (data.get("choices") or [{}])[0]
            reason = choice.get("finish_reason")
            if reason != "stop":
                raise ValueError("incomplete_or_filtered_output")
            if choice.get("flag", 0) != 0:
                raise ValueError("content_filtered")
            content = (choice.get("message") or {}).get("content")
            if not isinstance(content, str) or not content.replace("\ufeff", "").strip():
                raise ValueError("empty_content")
            if len(content) > 1000000:
                raise ValueError("output_too_large")
            emit({"ok": True, "content": content, "finish_reason": reason})
            return 0
        except urllib.error.HTTPError as error:
            if error.code == 429 and attempt < 3:
                try:
                    wait = float(error.headers.get("Retry-After") or 2 ** attempt)
                except (ValueError, TypeError):
                    wait = 2 ** attempt
                time.sleep(max(0, min(wait, 30)))
                continue
            emit({"ok": False, "error": "upstream_http_error", "status": error.code})
            return 1
        except (ValueError, KeyError, TypeError, IndexError):
            emit({"ok": False, "error": "invalid_or_incomplete_response"})
            return 1
        except Exception:
            emit({"ok": False, "error": "network_or_runtime_error"})
            return 1
    return 1

if __name__ == "__main__":
    sys.exit(main())
