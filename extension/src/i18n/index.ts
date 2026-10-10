// Build-time translated UI strings (Track A). Never call Bhashini for these.
import en from './en.json';

type Strings = Record<string, string>;
const tables: Record<string, Strings> = { en };

export function t(key: string, lang = 'en'): string {
  return tables[lang]?.[key] ?? en[key as keyof typeof en] ?? key;
}
