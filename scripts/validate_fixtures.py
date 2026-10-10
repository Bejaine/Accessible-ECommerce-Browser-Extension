#!/usr/bin/env python3
"""Validate every fixture in fixtures/mocks/ against its JSON Schema.

Fixtures are named <SchemaTitle>.json or <SchemaTitle>.<variant>.json; the schema is found
by title anywhere under shared/schemas/. Exits non-zero on any invalid or unmatched fixture.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parent.parent
SCHEMAS = ROOT / "shared" / "schemas"
FIXTURES = ROOT / "fixtures" / "mocks"


def load_schemas() -> tuple[dict[str, dict], Registry]:
    by_title: dict[str, dict] = {}
    resources = []
    for path in sorted(SCHEMAS.rglob("*.schema.json")):
        schema = json.loads(path.read_text())
        # No $id in the schemas: each one is addressed by its file URI so relative $refs resolve.
        schema = {"$id": path.as_uri(), **schema}
        by_title[schema["title"]] = schema
        resources.append((path.as_uri(), Resource.from_contents(schema)))
    return by_title, Registry().with_resources(resources)


def main() -> int:
    by_title, registry = load_schemas()
    errors = 0
    fixtures = sorted(FIXTURES.glob("*.json"))
    for path in fixtures:
        name = path.name.split(".")[0]
        schema = by_title.get(name)
        if schema is None:
            print(f"FAIL {path.relative_to(ROOT)}: no schema titled {name!r}")
            errors += 1
            continue
        validator = Draft202012Validator(schema, registry=registry, format_checker=FormatChecker())
        problems = list(validator.iter_errors(json.loads(path.read_text())))
        for err in problems:
            loc = "/".join(str(p) for p in err.absolute_path) or "(root)"
            print(f"FAIL {path.relative_to(ROOT)} at {loc}: {err.message}")
        errors += len(problems)
    missing = sorted(set(by_title) - {p.name.split(".")[0] for p in fixtures})
    for title in missing:
        print(f"FAIL no fixture for schema {title!r}")
    errors += len(missing)
    print(f"{len(fixtures)} fixtures checked against {len(by_title)} schemas, {errors} problem(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
