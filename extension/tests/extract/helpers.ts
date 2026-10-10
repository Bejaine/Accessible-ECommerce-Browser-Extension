// Loads the saved pages in fixtures/pages/ and validates output against shared/schemas/.
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PageType } from '@shared/index';

const ROOT = resolve(__dirname, '../../..');
const PAGES = join(ROOT, 'fixtures/pages');
const SCHEMAS = join(ROOT, 'shared/schemas');

/** Fixed clock so year-less delivery dates and extracted_at are deterministic. */
export const NOW = new Date('2026-10-10T12:00:00Z');

export interface PageFixture {
  file: string;
  url: string;
  page_type: PageType;
}

export const fixtures: PageFixture[] = JSON.parse(
  readFileSync(join(PAGES, 'manifest.json'), 'utf8'),
).pages;

const cache = new Map<string, Document>();

/** Parses a fixture without running its scripts (as the content script sees the DOM). */
export function loadPage(file: string): Document {
  let doc = cache.get(file);
  if (!doc) {
    doc = new DOMParser().parseFromString(readFileSync(join(PAGES, file), 'utf8'), 'text/html');
    cache.set(file, doc);
  }
  return doc;
}

export function fixture(file: string): PageFixture {
  const f = fixtures.find((p) => p.file === file);
  if (!f) throw new Error(`no fixture ${file}`);
  return f;
}

function schemaFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? schemaFiles(join(dir, e.name))
      : e.name.endsWith('.schema.json')
        ? [join(dir, e.name)]
        : [],
  );
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
// Same addressing as scripts/validate_fixtures.py: each schema's $id is its file URI.
for (const path of schemaFiles(SCHEMAS)) {
  ajv.addSchema({ ...JSON.parse(readFileSync(path, 'utf8')), $id: pathToFileURL(path).href });
}

/** Returns schema errors as readable strings; empty when valid. */
export function schemaErrors(
  schema: 'ProductJSON' | 'PageContext' | 'ActionTarget',
  data: unknown,
): string[] {
  const validate = ajv.getSchema(pathToFileURL(join(SCHEMAS, `${schema}.schema.json`)).href);
  if (!validate) throw new Error(`schema ${schema} not loaded`);
  if (validate(data)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message}`);
}
