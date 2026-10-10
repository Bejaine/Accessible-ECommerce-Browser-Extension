// Pre-recorded UI phrases (Track A): instant playback instead of a 3–19 s TTS call.
// Built by scripts/build_phrases.py into src/i18n/audio/<lang>/<key>.wav; manifest.json records
// the text each file was made from. A file is used only if that text is still the current
// UI string, so an outdated recording never plays (the caller then falls back to live TTS).
import { t } from '../i18n';
import manifest from '../i18n/audio/manifest.json';

type Recorded = Record<string, Record<string, string>>;

const urls = import.meta.glob<string>('../i18n/audio/*/*.wav', {
  eager: true,
  query: '?url',
  import: 'default',
});

/** "../i18n/audio/hi/cart.added.wav" -> "hi/cart.added" */
const files: Record<string, string> = Object.fromEntries(
  Object.entries(urls).map(([path, url]) => [path.replace(/^.*\/audio\/|\.wav$/g, ''), url]),
);

export function phraseAudioUrl(key: string, lang: string): string | null {
  return phraseAudioUrlFrom(files, manifest as Recorded, key, lang, t(key, lang));
}

/** The lookup itself, separated so it can be tested without real files. */
export function phraseAudioUrlFrom(
  available: Record<string, string>,
  recorded: Recorded,
  key: string,
  lang: string,
  currentText: string,
): string | null {
  const url = available[`${lang}/${key}`];
  return url && recorded[lang]?.[key] === currentText ? url : null;
}
