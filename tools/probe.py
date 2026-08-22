#!/usr/bin/env python3
"""Quick API prober for scouting a new anime source before writing a Kotlin client for it.

Fetches a URL, pretty-prints the JSON body (or raw text if it isn't JSON), and shows the
status/content-type up front. Zero dependencies beyond the standard library, so it runs
anywhere python3 does -- no venv, no pip install.

Examples:
    python3 tools/probe.py "https://kaa.lt/api/show/trending?page=1"
    python3 tools/probe.py "https://kaa.lt/api/fsearch" -X POST -d '{"page":1,"query":"bungo"}' \\
        -H "Content-Type: application/json"
    python3 tools/probe.py "https://example.com/anime/1" -H "Lang: ru" --path result.0.title
    python3 tools/probe.py "https://example.com/page.html" --raw   # skip JSON parsing entirely
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


def parse_headers(raw_headers: list[str]) -> dict[str, str]:
    headers: dict[str, str] = {}
    for item in raw_headers:
        if ":" not in item:
            raise SystemExit(f"Invalid header (expected 'Name: value'): {item!r}")
        name, value = item.split(":", 1)
        headers[name.strip()] = value.strip()
    return headers


def walk_path(value, path: str):
    """Follows a dotted path like 'result.0.title' through parsed JSON."""
    current = value
    for part in path.split("."):
        if isinstance(current, list):
            current = current[int(part)]
        elif isinstance(current, dict):
            current = current[part]
        else:
            raise KeyError(f"Can't descend into {type(current).__name__} with '{part}'")
    return current


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("url")
    parser.add_argument("-X", "--method", default=None, help="HTTP method (default: GET, or POST if -d is given)")
    parser.add_argument("-H", "--header", action="append", default=[], help="Extra header, 'Name: value'. Repeatable.")
    parser.add_argument("-d", "--data", default=None, help="Request body (implies POST unless -X is set)")
    parser.add_argument("--ua", default=DEFAULT_USER_AGENT, help="Override the User-Agent header")
    parser.add_argument("--no-ua", action="store_true", help="Don't send a User-Agent at all")
    parser.add_argument("--timeout", type=float, default=15.0, help="Request timeout in seconds (default: 15)")
    parser.add_argument("--raw", action="store_true", help="Print the raw body, skip JSON parsing/pretty-printing")
    parser.add_argument("--path", default=None, help="Dotted path into the parsed JSON to print instead of the whole body, e.g. result.0.title")
    parser.add_argument("--max-chars", type=int, default=4000, help="Truncate printed output to this many characters (0 = no limit)")
    args = parser.parse_args()

    headers = parse_headers(args.header)
    if not args.no_ua and not any(k.lower() == "user-agent" for k in headers):
        headers["User-Agent"] = args.ua

    method = args.method or ("POST" if args.data is not None else "GET")
    body = args.data.encode("utf-8") if args.data is not None else None
    if body is not None and not any(k.lower() == "content-type" for k in headers):
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(args.url, data=body, headers=headers, method=method)

    print(f"--> {method} {args.url}", file=sys.stderr)
    if headers:
        for name, value in headers.items():
            print(f"    {name}: {value}", file=sys.stderr)
    if body:
        print(f"    body: {args.data}", file=sys.stderr)

    try:
        with urllib.request.urlopen(request, timeout=args.timeout) as response:
            status = response.status
            content_type = response.headers.get("Content-Type", "")
            raw = response.read()
    except urllib.error.HTTPError as error:
        status = error.code
        content_type = error.headers.get("Content-Type", "") if error.headers else ""
        raw = error.read()

    print(f"<-- {status} {content_type}", file=sys.stderr)

    text = raw.decode("utf-8", errors="replace")

    if not args.raw:
        try:
            parsed = json.loads(text)
            if args.path:
                parsed = walk_path(parsed, args.path)
            text = json.dumps(parsed, indent=2, ensure_ascii=False)
        except (json.JSONDecodeError, KeyError, IndexError, ValueError) as error:
            print(f"    (not valid JSON at requested path: {error}; showing raw body)", file=sys.stderr)

    if args.max_chars and len(text) > args.max_chars:
        text = text[: args.max_chars] + f"\n... [truncated, {len(text) - args.max_chars} more chars]"

    print(text)


if __name__ == "__main__":
    main()
