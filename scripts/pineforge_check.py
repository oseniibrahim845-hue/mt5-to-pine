"""Run Pine v6 files through pineforge-codegen (Pine -> C++).

Dev-only check: pineforge-codegen is PolyForm Noncommercial licensed and is not
shipped with this project. Usage: python scripts/pineforge_check.py file.pine [...]
Exit code 1 if any file fails.
"""
import json
import sys

from pineforge_codegen import transpile_full

failed = 0
for path in sys.argv[1:]:
    src = open(path, encoding="utf-8").read()
    try:
        res = transpile_full(src)
        warnings = getattr(res, "warnings", None) or (res.get("warnings") if isinstance(res, dict) else None) or []
        print(json.dumps({"file": path, "ok": True, "warnings": [str(w) for w in warnings]}))
    except Exception as e:  # CompileError and friends
        failed += 1
        print(json.dumps({"file": path, "ok": False, "error": f"{type(e).__name__}: {e}"}))
sys.exit(1 if failed else 0)
