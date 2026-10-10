# Run from the repo root. `make setup` once, then `make check` before every PR.
SHELL := /bin/bash
PY ?= python3.11
VENV := .venv
BIN := $(CURDIR)/$(VENV)/bin
GEN_PY := $(CURDIR)/shared/generated/py

.PHONY: setup types types-check check lint lint-ts lint-py test test-ext test-backend validate backend ext ext-firefox build eval-inference

setup:
	npm install
	test -x $(BIN)/python || $(PY) -m venv $(VENV)
	if command -v uv >/dev/null; then uv pip install --python $(BIN)/python -e "backend[dev]"; \
	else $(BIN)/pip install -e "backend[dev]"; fi

types:
	node scripts/gen_ts.mjs
	PY=$(BIN) scripts/gen_py.sh

# Fails if shared/generated/ is out of date with shared/schemas/.
types-check:
	@tmp=$$(mktemp -d); cp -r shared/generated "$$tmp/before"; \
	$(MAKE) --no-print-directory types >/dev/null; \
	if ! diff -r -x __pycache__ "$$tmp/before" shared/generated >/dev/null; then \
	  echo "shared/generated was stale; it has been regenerated. Review and commit it."; rm -rf "$$tmp"; exit 1; fi; \
	rm -rf "$$tmp"; echo "generated types are up to date"

check: types-check lint test validate

lint: lint-ts lint-py

lint-ts:
	npx prettier --check .
	npx eslint .
	cd extension && npx wxt prepare >/dev/null && npx tsc --noEmit

lint-py:
	$(BIN)/ruff check backend scripts
	$(BIN)/ruff format --check backend scripts

test: test-ext test-backend

test-ext:
	npm run -w extension test

test-backend:
	cd backend && $(BIN)/pytest -q

validate:
	$(BIN)/python scripts/validate_fixtures.py

backend:
	cd backend && PYTHONPATH=$(GEN_PY) $(BIN)/uvicorn app.main:app --reload --port 8000 \
	  $$( [ -f ../.env ] && echo --env-file ../.env )

ext:
	npm run -w extension dev

ext-firefox:
	npm run -w extension dev:firefox

build:
	npm run -w extension build
	npm run -w extension build:firefox

eval-inference:
	npm run -w extension eval:inference
