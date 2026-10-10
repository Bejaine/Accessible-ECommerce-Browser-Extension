// Build-time translated UI strings (Track A). Never call Bhashini for these at runtime.
// en.json is the source; hi.json and te.json are filled by scripts/build_phrases.py and may be
// hand-corrected (the script never overwrites an existing entry).
import en from './en.json';
import hi from './hi.json';
import te from './te.json';

type Strings = Record<string, string>;
const tables: Record<string, Strings> = { en, hi, te };

export function t(key: string, lang = 'en'): string {
  return tables[lang]?.[key] ?? en[key as keyof typeof en] ?? key;
}
