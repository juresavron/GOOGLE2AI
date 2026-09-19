#!/usr/bin/env python3
"""Parse every .sql file with Postgres's own grammar.

The Node suite never executes this SQL -- it drives db.ts against a fake -- so a typo in a schema
file or a query string would first be discovered by the one code path that uses it, in production.
pglast is libpg_query, which is the real parser, so this catches exactly what Postgres would.

Mirrors whatsapp2ai's scripts/check-sql.py, and runs in the same CI step.
"""
import pathlib
import sys

try:
    import pglast
except ImportError:
    print("pglast is not installed: pip install pglast", file=sys.stderr)
    sys.exit(2)

root = pathlib.Path(__file__).resolve().parent.parent
files = sorted(root.glob("db/*.sql"))
if not files:
    print("no db/*.sql found -- did the schema move?", file=sys.stderr)
    sys.exit(1)

bad = 0
for f in files:
    try:
        pglast.parse_sql(f.read_text())
        print(f"ok   {f.relative_to(root)}")
    except Exception as e:  # noqa: BLE001 -- the parser raises several types
        bad += 1
        print(f"FAIL {f.relative_to(root)}: {e}", file=sys.stderr)

sys.exit(1 if bad else 0)
