# Tools

## `probe.py`

Zero-dependency API prober for scouting a new source before writing its Kotlin client.
Pretty-prints JSON, shows status/content-type, supports custom headers/POST bodies, and can
drill into a specific field with `--path`.

```bash
python3 tools/probe.py "https://kaa.lt/api/show/trending?page=1"
python3 tools/probe.py "https://kaa.lt/api/fsearch" -d '{"page":1,"query":"bungo"}'
python3 tools/probe.py "https://example.com/anime/1" -H "Lang: ru" --path result.0.title
```

Run `python3 tools/probe.py --help` for the full flag list.
