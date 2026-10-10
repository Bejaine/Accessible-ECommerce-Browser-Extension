// Overlay controls: phrase board + switch scanning (scan bar, scanner, switch key) as one unit.
// The switch key is attached only while scanning runs, so Space keeps working on the page
// for everyone else.
import type { ActionTarget, PageType, ResolvedMode } from '@shared/index';
import { announce } from './announce';
import { createPhraseBoard, phraseLabel, phrasesFor, type Phrase } from './phrases';
import { createScanBar } from './scanBar';
import { groupsFromTargets } from './scanGroups';
import { createScanner, type ScanGroup } from './scanner';
import { label } from './strings';
import { attachSwitch } from './switchInput';

export interface ControlsOptions {
  container: HTMLElement;
  mode: ResolvedMode;
  /** Prefs.switch_key (KeyboardEvent.code). */
  switchKey: string;
  /** Speak every highlight (visual active); see isAuditoryScanning(). */
  auditory: boolean;
  lang?: string;
  onPhrase: (phrase: { id: string; text: string }) => void;
  onSelectTarget: (target: ActionTarget) => void;
}

export interface Controls {
  showPhrases(context: PageType | 'confirm'): void;
  /** Scan the page's targets (by zone) plus the phrase board. */
  startScanning(targets: ActionTarget[]): void;
  stopScanning(): void;
  readonly scanning: boolean;
  /** Stop scanning and remove the controls (e.g. before rebuilding for a new mode). */
  destroy(): void;
}

const keyName = (code: string) => code.replace(/^(Key|Digit)/, '');

export function createControls(opts: ControlsOptions): Controls {
  const lang = opts.lang;
  let phrases: Phrase[] = [];
  let detachSwitch: (() => void) | null = null;

  const board = createPhraseBoard({
    pageSize: opts.mode.max_options,
    onChoose: opts.onPhrase,
    lang,
  });
  const bar = createScanBar(
    {
      onChoose: () => scanner.press(),
      onStop: () => stopScanning(),
      switchName: keyName(opts.switchKey),
    },
    lang,
  );
  const pausedText = label('scan.paused', lang);
  const scanner = createScanner({
    intervalMs: opts.mode.scan_interval_ms,
    backLabel: label('scan.back', lang),
    pausedLabel: pausedText,
    onHighlight: (h) => bar.update(h, scanner.level === 'paused' ? pausedText : undefined),
    speak: opts.auditory ? (text) => announce(text) : undefined,
  });
  opts.container.append(board.element, bar.element);

  function phraseGroup(): ScanGroup {
    return {
      id: 'phrases',
      label: label('phrases.title', lang),
      items: phrases.map((p) => ({
        id: `phrase-${p.id}`,
        label: phraseLabel(p.id, lang),
        activate: () => opts.onPhrase({ id: p.id, text: phraseLabel(p.id, lang) }),
      })),
    };
  }

  function stopScanning(): void {
    scanner.stop();
    detachSwitch?.();
    detachSwitch = null;
    bar.update(null);
  }

  return {
    showPhrases(context) {
      phrases = phrasesFor(context);
      board.show(phrases);
    },
    startScanning(targets) {
      detachSwitch ??= attachSwitch(document, {
        code: opts.switchKey,
        onPress: () => scanner.press(),
      });
      scanner.start([...groupsFromTargets(targets, opts.onSelectTarget, lang), phraseGroup()]);
      if (scanner.level === 'stopped') stopScanning();
    },
    stopScanning,
    get scanning() {
      return scanner.level !== 'stopped';
    },
    destroy() {
      stopScanning();
      board.element.remove();
      bar.element.remove();
    },
  };
}
