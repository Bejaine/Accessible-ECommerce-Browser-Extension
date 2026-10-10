// The content-script app: overlay, renderers, controls, turns and confirmations, on-device
// inference and suggestions, wired to the bus and the profile store. Integration lead owns this.
//
// Input routes:
// - phrase chips, suggestion chips, scan selections, typed/spoken text (`say`)
// - local commands first (yes / no / repeat / help / slower / faster / undo): no server call
// - everything else becomes a turn (TurnRequest -> backend -> output, actions, confirmation)
import type { AccessibleOutput, AsrMeta, PageContext, Profile } from '@shared/index';
import { browser } from 'wxt/browser';
import { performAction } from '../actuate';
import { createMic, MicError, toAsrRequest, type Mic } from '../audio/mic';
import { extractPageContext, resolveTarget } from '../extract';
import { t } from '../i18n';
import { attachCollectors } from '../infer/collectors';
import { createScoreEngine, type InferredCondition, type ScoreEngine } from '../infer/scores';
import { createSuggester, type Suggester } from '../infer/suggest';
import { buildCandidates, createMatcher } from '../match';
import { renderOutput, type RenderedOutput } from '../render';
import { createSpeaker, type Speaker } from '../render/speaker';
import { announce, resetAnnouncer, setAnnounceVoice } from '../ui/announce';
import { createConfirmCard, formatMoney } from '../ui/confirmCard';
import { createMicButton } from '../ui/micButton';
import { createSettings } from '../ui/settings';
import {
  createPlaybackBar,
  MINI_MENU,
  miniMenuLabel,
  type PlaybackAction,
} from '../ui/playbackBar';
import { createScanner } from '../ui/scanner';
import { createActionMenu } from '../ui/actionMenu';
import { createColourLabels, type ColourLabels } from '../ui/colourLabels';
import { renderSimpleView, simpleSummary } from '../ui/simpleView';
import { createControls, type Controls } from '../ui/controls';
import { mountOverlay, type Overlay } from '../ui/overlay';
import { createSpeechSpeed, formatRate } from '../ui/speechSpeed';
import { label, setUiLang } from '../ui/strings';
import { createSuggestionCard } from '../ui/suggestionCard';
import type { BackendClient } from './backend';
import type { Bus } from './bus';
import {
  confirmEveryAction,
  isAuditoryScanning,
  resolveMode,
  setConditionActive,
  stepRate,
} from './composer';
import {
  assistantVoiceOn,
  OPEN_ONBOARDING,
  saveDevicePrefs,
  type DevicePrefs,
  type ProfileStore,
} from './profile';
import { createInputFallback } from './fallback';
import { createSession } from './session';
import { createTurnPipeline, localOutput, type PerformFn, type TurnPipeline } from './turn';

export const SUGGEST_CHECK_MS = 2000;

/** Phrase-board ids handled on the device instead of by a turn. */
const LOCAL_PHRASES = new Set(['yes', 'no', 'repeat', 'help']);

/** Phrases answered from the precomputed /product/prepare sections (English only; other
 *  languages go through a turn, which translates). */
const SECTION_FOR_PHRASE = {
  reviews: 'reviews',
  specs: 'specs',
  price: 'overview',
  read_page: 'overview',
} as const;

export const URL_CHECK_MS = 1000;

/** Typing a space in a text field must never count as a switch press. */
function isEditable(target: EventTarget | undefined): boolean {
  const el = target instanceof HTMLElement ? target : null;
  return Boolean(el && (el.isContentEditable || el.closest('input, textarea, select')));
}

export interface App {
  overlay: Overlay;
  readonly controls: Controls;
  engine: ScoreEngine;
  suggester: Suggester;
  turn: TurnPipeline;
  /** Handle an utterance as if spoken or typed: local fast path first, else a turn. */
  say(text: string, kind?: 'voice' | 'text', asrMeta?: AsrMeta | null): Promise<void>;
  /** Start (or stop) listening with the microphone; call from a user gesture. */
  listen(): Promise<void>;
  /** Open or close the assistant (keyboard shortcut); speaks a short orientation on open. */
  toggleAssistant(): void;
  /** The single playback key (Alt+Shift+K): pause / resume, or pick from the spoken mini-menu. */
  playbackKey(): void;
  speaker: Speaker;
  unmount(): void;
}

export interface AppOptions {
  /** One microphone per tab (Track A); injectable for tests. */
  mic?: Mic;
  /** The assistant's own voice; injectable for tests. */
  speaker?: Speaker;
  /** Device-only preferences (assistant voice). */
  devicePrefs?: DevicePrefs;
  /** True when the backend is the in-browser mock: no real speech recognition or voices. */
  demo?: boolean;
}

export function mountApp(
  container: HTMLElement,
  store: ProfileStore,
  bus: Bus,
  backend: BackendClient,
  options: AppOptions = {},
): App {
  setUiLang(store.get().prefs.lang);
  const overlay = mountOverlay(container);
  const engine = createScoreEngine();
  const devicePrefs: DevicePrefs = options.devicePrefs ?? { assistantVoice: 'auto' };
  const demo = options.demo ?? false;
  const session = createSession();
  const offs: (() => void)[] = [];
  let profile = store.get();
  let mode = resolveMode(profile);
  let lastOutput: AccessibleOutput | null = null;
  const lang = () => profile.prefs.lang;

  // --- The assistant's own voice (users without a screen reader) ---
  const speaker =
    options.speaker ??
    createSpeaker({
      tts: demo ? undefined : (text, l) => backend.tts({ schema_version: '1.0', text, lang: l }),
    });
  speaker.setRate(profile.prefs.tts_rate);
  const voiceOn = () => assistantVoiceOn(profile, devicePrefs);
  setAnnounceVoice((text) => {
    if (voiceOn()) speaker.prompt(text, lang());
  });
  let view: RenderedOutput | null = null;
  offs.push(speaker.onChange((speaking) => view?.setReading(speaking)));
  const mic = options.mic ?? createMic();
  let page: PageContext = extractPageContext();
  const prepared = new Map<
    string,
    NonNullable<Awaited<ReturnType<BackendClient['prepareProduct']>>['sections']>
  >();

  // --- Output ---
  function showOutput(output: AccessibleOutput): void {
    lastOutput = output;
    view = renderOutput(overlay.content, output, {
      maxOptions: mode.max_options,
      onFollowup: (text) => bus.emit({ type: 'followup', text }),
      onBack: backToMenu,
      onReadAloud: (start) => {
        if (start) speaker.speakOutput(output, { verbosity: mode.verbosity });
        else speaker.stop();
      },
    });
    // Screen readers get the summary from the live region; the assistant's voice reads the
    // whole answer (summary first, then sections) when it is on.
    announce(output.summary, { speak: false });
    if (voiceOn()) {
      speaker.speakOutput(output, { verbosity: mode.verbosity });
      hintOnce();
    }
  }

  /** The playback controls are announced once per session. */
  function hintOnce(): void {
    try {
      if (sessionStorage.getItem('asl-playback-hint')) return;
      sessionStorage.setItem('asl-playback-hint', '1');
    } catch {
      return;
    }
    announce(label('playback.hint', lang()), { speak: false });
  }

  /** Close the answer and go back to the menu (the controls), keeping it for "repeat". */
  function backToMenu(): void {
    speaker.stop();
    view = null;
    overlay.content.replaceChildren();
    overlay.setWide(false);
    overlay.controls.querySelector<HTMLElement>('button')?.focus();
  }

  // --- Turns and confirmations ---
  const confirmCard = createConfirmCard({
    onYes: () => void turn.confirm(),
    onNo: () => turn.cancel(),
  });
  const turn = createTurnPipeline({
    backend,
    session,
    getProfile: () => profile,
    getPage: () => extractPageContext(),
    // Works with both the actuator stub and Track B's (action, { confirmed }) version.
    perform: performAction as PerformFn,
    showOutput,
    showConfirmation: (confirmation) => {
      if (confirmation && !overlay.isOpen) overlay.open();
      confirmCard.show(confirmation, confirmation !== null);
    },
    announce: (text, assertive) => announce(text, { assertive }),
    confirmEveryAction: () => confirmEveryAction(profile),
  });

  // --- Speech speed (starting defaults come from conditions; the user changes it here) ---
  const speed = createSpeechSpeed((direction) => void stepSpeed(direction));
  speed.render(profile.prefs.tts_rate);
  async function stepSpeed(direction: 1 | -1): Promise<void> {
    await store.update((draft) => {
      draft.prefs.tts_rate = stepRate(draft.prefs.tts_rate, direction);
    });
    speaker.setRate(profile.prefs.tts_rate);
    // While an answer is playing, just change its speed; don't interrupt it to announce.
    announce(label('speed.now', lang()).replace('{rate}', formatRate(profile.prefs.tts_rate)), {
      speak: !speaker.speaking,
    });
  }

  // --- Suggestions (rule 5) ---
  const suggester = createSuggester({
    engine,
    isActive: (c) => profile.conditions[c].active,
    apply: (c, score) => void setCondition(c, true, score),
    revert: (c) => void setCondition(c, false),
    announce: (text, assertive) => announce(text, { assertive }),
  });
  const suggestionCard = createSuggestionCard(suggester);
  offs.push(
    suggester.subscribe((state) => {
      suggestionCard.render(state);
      overlay.setBadge(state.kind === 'idle' ? null : label('overlay.badge'));
    }),
  );
  function setCondition(c: InferredCondition, active: boolean, score?: number) {
    return store.update((draft) => setConditionActive(draft, c, active, 'inferred', score));
  }

  const settings = createSettings({
    store,
    onStartScanning: () => {
      overlay.open();
      controls.startScanning(extractPageContext().targets);
    },
    onRunSetup: () =>
      void browser.runtime
        .sendMessage({ type: OPEN_ONBOARDING })
        .catch(() => announce(label('turn.failed', lang()), { assertive: true })),
    voice: {
      get: voiceOn,
      set: (on) => {
        devicePrefs.assistantVoice = on ? 'on' : 'off';
        if (!on) speaker.stop();
        void saveDevicePrefs(devicePrefs);
      },
    },
  });
  settings.render(profile, mode);
  // --- Page tools: simplified view, action menu, colour labels ---
  const pageTools = document.createElement('div');
  pageTools.className = 'asl-chips';
  const simpleButton = document.createElement('button');
  simpleButton.type = 'button';
  simpleButton.className = 'asl-menu-toggle';
  simpleButton.textContent = label('simple.open');
  simpleButton.addEventListener('click', () => showSimpleView());
  const actionMenu = createActionMenu((target) => bus.emit({ type: 'select-target', target }));
  pageTools.append(simpleButton);
  let colourLabels: ColourLabels | null = null;

  function updateColourLabels(): void {
    if (profile.conditions.colour.active) {
      colourLabels ??= createColourLabels(container, (id) => resolveTarget(id));
      colourLabels.render(page.targets);
    } else {
      colourLabels?.destroy();
      colourLabels = null;
    }
  }

  function refreshPageTools(): void {
    page = extractPageContext();
    actionMenu.render(page.targets);
    simpleButton.hidden = !(page.page_type === 'product' && page.products[0]);
    updateColourLabels();
  }

  function showSimpleView(): void {
    const product = page.page_type === 'product' ? page.products[0] : undefined;
    if (!product) return;
    speaker.stop();
    view = null;
    overlay.setWide(true);
    overlay.content.replaceChildren(
      renderSimpleView(product, page.targets, {
        onSelect: (target) => bus.emit({ type: 'select-target', target }),
        onBack: backToMenu,
        maxActions: mode.max_options,
      }),
    );
    overlay.content.querySelector<HTMLElement>('h3')?.setAttribute('tabindex', '-1');
    overlay.content.querySelector<HTMLElement>('h3')?.focus();
    announce(simpleSummary(product));
  }

  offs.push(
    overlay.onOpen(() => {
      refreshPageTools();
      // Simple mode on a product page opens straight into the simplified view.
      if (profile.conditions.ageing.active && !overlay.content.hasChildNodes()) showSimpleView();
    }),
    () => colourLabels?.destroy(),
  );

  overlay.controls.append(
    confirmCard.element,
    suggestionCard.element,
    pageTools,
    actionMenu.element,
    speed.element,
    settings.element,
  );

  // --- Phrase board and switch scanning (rebuilt when the mode changes) ---
  function buildControls(p: Profile): Controls {
    const c = createControls({
      container: overlay.controls,
      mode,
      switchKey: p.prefs.switch_key,
      auditory: isAuditoryScanning(p),
      onPhrase: (phrase) => bus.emit({ type: 'phrase', id: phrase.id, text: phrase.text }),
      onSelectTarget: (target) => bus.emit({ type: 'select-target', target }),
    });
    c.showPhrases(page.page_type);
    return c;
  }
  let controls = buildControls(profile);
  const controlsKey = (p: Profile) =>
    JSON.stringify([resolveMode(p), p.prefs.switch_key, isAuditoryScanning(p)]);
  let builtFor = controlsKey(profile);

  overlay.setTextScale(profile.prefs.text_scale);
  offs.push(
    store.subscribe((next) => {
      profile = next;
      mode = resolveMode(next);
      overlay.setTextScale(next.prefs.text_scale);
      speed.render(next.prefs.tts_rate);
      speaker.setRate(next.prefs.tts_rate);
      settings.render(next, mode);
      updateColourLabels();
      const key = controlsKey(next);
      if (key !== builtFor) {
        builtFor = key;
        controls.destroy();
        controls = buildControls(next);
      }
    }),
  );

  // --- Playback controls (bar, voice words, single key with a spoken mini-menu) ---
  function playback(action: PlaybackAction): void {
    switch (action) {
      case 'toggle':
        if (speaker.state === 'playing') speaker.pause();
        else if (speaker.state === 'paused') speaker.resume();
        else if (lastOutput) speaker.speakOutput(lastOutput, { verbosity: mode.verbosity });
        else announce(label('playback.nothing', lang()));
        break;
      case 'repeat':
        speaker.repeatSentence();
        break;
      case 'repeat_all':
        if (speaker.state === 'idle' && lastOutput)
          speaker.speakOutput(lastOutput, { verbosity: mode.verbosity });
        else speaker.repeatAll();
        break;
      case 'back':
        speaker.back();
        break;
      case 'previous':
        speaker.previousSection();
        break;
      case 'next':
        speaker.nextSection();
        break;
      case 'slower':
        void stepSpeed(-1);
        break;
      case 'faster':
        void stepSpeed(1);
        break;
      case 'stop':
        speaker.stop();
        break;
    }
  }
  const playbackBar = createPlaybackBar((action) => {
    closeMiniMenu();
    playback(action);
  });
  overlay.floating.append(playbackBar.element);
  offs.push(speaker.onChange((_, state, sentence) => playbackBar.update(state, sentence)));

  // Single key: press while playing -> pause; press while paused -> resume; or wait 1.5 s and the
  // mini-menu is scanned aloud (same model as switch access), and the same key picks an item.
  const MENU_DELAY_MS = 1500;
  let menuTimer: ReturnType<typeof setTimeout> | undefined;
  const miniMenu = createScanner({
    intervalMs: mode.scan_interval_ms,
    backLabel: '',
    pausedLabel: label('scan.paused', lang()),
    onHighlight: (h) => playbackBar.highlight((h?.item?.id as PlaybackAction | undefined) ?? null),
    speak: (text) => speaker.prompt(text, lang()),
  });
  function closeMiniMenu(): void {
    clearTimeout(menuTimer);
    if (miniMenu.level !== 'stopped') miniMenu.stop();
    playbackBar.highlight(null);
  }
  function playbackKey(): void {
    if (miniMenu.level !== 'stopped') {
      miniMenu.press(); // picks the highlighted item (or resumes a paused menu)
      return;
    }
    if (speaker.state === 'playing') {
      speaker.pause();
      clearTimeout(menuTimer);
      menuTimer = setTimeout(() => {
        if (speaker.state !== 'paused') return;
        miniMenu.start([
          {
            id: 'playback',
            label: label('playback.title', lang()),
            items: MINI_MENU.map((action) => ({
              id: action,
              label: miniMenuLabel(action),
              activate: () => {
                closeMiniMenu();
                playback(action);
              },
            })),
          },
        ]);
      }, MENU_DELAY_MS);
      return;
    }
    closeMiniMenu();
    playback('toggle');
  }
  offs.push(closeMiniMenu);

  // --- Local commands (no server call) ---
  function runCommand(id: string): boolean {
    switch (id) {
      case 'yes':
        void turn.confirm();
        return true;
      case 'no':
        if (turn.pending) turn.cancel();
        else suggester.decline();
        return true;
      case 'repeat':
        if (speaker.state !== 'idle') speaker.repeatSentence();
        else announce(lastOutput ? lastOutput.summary : label('repeat.nothing', lang()));
        return true;
      case 'repeat_all':
        if (speaker.state !== 'idle' || lastOutput) playback('repeat_all');
        else announce(label('repeat.nothing', lang()));
        return true;
      case 'pause':
        speaker.pause();
        return true;
      case 'resume':
        playback('toggle');
        return true;
      case 'stop':
        speaker.stop();
        return true;
      case 'back':
        speaker.back();
        return true;
      case 'next_section':
        speaker.nextSection();
        return true;
      case 'previous_section':
        speaker.previousSection();
        return true;
      case 'help':
        engine.add('help_use');
        showOutput(
          localOutput(label('help.summary', lang()), lang(), {
            sections: [
              {
                heading: label('help.heading', lang()),
                items: label('help.examples', lang())
                  .split(' | ')
                  .map((text) => ({ text, kind: 'text' as const, grounding_index: null })),
                table: null,
                simpler: null,
              },
            ],
          }),
        );
        return true;
      case 'slower':
        void stepSpeed(-1);
        return true;
      case 'faster':
        void stepSpeed(1);
        return true;
      case 'undo':
        suggester.undo();
        return true;
      default:
        return false;
    }
  }

  async function say(
    text: string,
    kind: 'voice' | 'text' = 'voice',
    asrMeta: AsrMeta | null = null,
  ): Promise<void> {
    const current = extractPageContext();
    const matcher = createMatcher(
      buildCandidates({ targets: current.targets, products: current.products }),
    );
    const decision = matcher.match(text);
    if (decision.action === 'act') {
      const { candidate } = decision.best;
      if (candidate.kind === 'command' && runCommand(candidate.id)) return;
      if (candidate.kind === 'target') {
        return turn.send({ kind, text, target_id: candidate.id, asr_meta: asrMeta });
      }
    }
    return turn.send({ kind, text, asr_meta: asrMeta });
  }

  // --- Page: extract at load and on SPA URL changes; precompute sections (Tracks B, C) ---
  function preparedSection(phraseId: string): AccessibleOutput | null {
    if (lang() !== 'en' || !(phraseId in SECTION_FOR_PHRASE)) return null;
    const product = page.products[0];
    const sections = product ? prepared.get(product.id) : undefined;
    return sections?.[SECTION_FOR_PHRASE[phraseId as keyof typeof SECTION_FOR_PHRASE]] ?? null;
  }

  function preparePage(): void {
    const product =
      page.page_type === 'product' && !page.secure_zone_active ? page.products[0] : undefined;
    if (!product || prepared.has(product.id)) return;
    // Read-aloud users hear title and price from the page at once (grounded in ProductJSON).
    if (profile.conditions.visual.active && product.title) {
      const price = product.price ? formatMoney(product.price, lang()) : null;
      announce(price ? `${product.title}. ${price}.` : product.title);
    }
    backend
      .prepareProduct({ schema_version: '1.0', product, prefs: profile.prefs })
      .then((res) => prepared.set(product.id, res.sections))
      .catch(() => undefined); // phrases fall back to a turn
  }

  let lastUrl = location.href;
  const urlTimer = setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    refreshPageTools();
    controls.showPhrases(page.page_type);
    preparePage();
  }, URL_CHECK_MS);
  offs.push(() => clearInterval(urlTimer));
  refreshPageTools();
  preparePage();

  // --- Voice (Track A's microphone): listen -> /speech/asr -> local fast path or a turn ---
  let fallback = createInputFallback(mode);
  offs.push(store.subscribe(() => (fallback = createInputFallback(mode))));
  const micButton = createMicButton(() => void listen());
  overlay.controls.prepend(micButton.element);

  function notUnderstood(): void {
    const step = fallback.recordFailure();
    if (step.offerPhrases) {
      // Two misses in a row: offer phrases instead of asking a third time.
      overlay.open();
      announce(label('phrases.offer', lang()), { assertive: true });
    } else {
      announce(label('mic.not_understood', lang()), { assertive: true });
    }
  }

  async function listen(): Promise<void> {
    if (mic.listening) {
      mic.stop();
      return;
    }
    if (demo) {
      // The mock backend can't recognise speech: say so instead of pretending to listen.
      announce(label('mic.demo', lang()), { assertive: true });
      return;
    }
    micButton.setListening(true);
    speaker.stop(); // don't let the assistant's voice be heard by the mic
    announce(t('mic.listening', lang()), { speak: false });
    try {
      const utterance = await mic.listen({
        mode: profile.conditions.speech.active ? 'speech' : 'default',
        onLevel: (level) => micButton.level(level),
      });
      micButton.setListening(false);
      if (utterance.reason === 'muted') return;
      if (!utterance.audioBase64) {
        // Silence with a near-zero level is a mic/environment problem, not unclear speech.
        announce(t('mic.no_speech', lang()));
        return;
      }
      const asr = await backend.asr(toAsrRequest(utterance, lang()));
      if (!asr.text.trim()) {
        if (utterance.micLevel > 0.1) engine.add('unheard_speech');
        notUnderstood();
        return;
      }
      fallback.recordSuccess();
      await say(asr.text, 'voice', asr.asr_meta);
    } catch (error) {
      micButton.setListening(false);
      const message =
        error instanceof MicError ? t(`mic.${error.code}`, lang()) : label('turn.failed', lang());
      announce(message, { assertive: true });
    }
  }

  offs.push(
    bus.on('announce', (m) => announce(m.text, { assertive: m.assertive })),
    bus.on('output', (m) => showOutput(m.output)),
    bus.on('phrase', (m) => {
      if (LOCAL_PHRASES.has(m.id)) {
        runCommand(m.id);
        return;
      }
      const cached = preparedSection(m.id);
      if (cached) showOutput(cached);
      else void turn.send({ kind: 'phrase', phrase_id: m.id, text: m.text });
    }),
    bus.on('followup', (m) => void say(m.text, 'text')),
    bus.on(
      'select-target',
      (m) => void turn.send({ kind: 'switch', target_id: m.target.id, text: m.target.label }),
    ),
  );

  // --- Inference (on device only) ---
  offs.push(attachCollectors(engine));
  if (profile.prefs.text_scale > 1) engine.add('large_text');
  const tick = setInterval(() => suggester.check(), SUGGEST_CHECK_MS);
  offs.push(
    () => clearInterval(tick),
    () => suggester.dispose(),
  );

  // --- Keys: a pending confirmation first (switch = yes, Escape = no), then a suggestion ---
  const onKey = (e: KeyboardEvent) => {
    const isSwitch = e.code === profile.prefs.switch_key && !isEditable(e.composedPath()[0]);
    if (e.key !== 'Escape' && !isSwitch) return;
    const suggestionWaiting =
      suggester.state.kind === 'countdown' || suggester.state.kind === 'question';
    if (!turn.pending && !suggestionWaiting) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (turn.pending) {
      if (isSwitch) void turn.confirm();
      else turn.cancel();
    } else if (suggester.state.kind === 'question') {
      suggester.answer('neither');
    } else {
      suggester.decline();
    }
  };
  document.addEventListener('keydown', onKey, { capture: true });
  offs.push(() => document.removeEventListener('keydown', onKey, { capture: true }));

  return {
    overlay,
    get controls() {
      return controls;
    },
    engine,
    suggester,
    turn,
    say,
    listen,
    speaker,
    playbackKey,
    toggleAssistant() {
      if (overlay.isOpen) {
        overlay.close();
        return;
      }
      overlay.open();
      announce(label('overlay.opened', lang()));
    },
    unmount() {
      mic.stop();
      speaker.stop();
      controls.destroy();
      offs.forEach((off) => off());
      resetAnnouncer();
      overlay.destroy();
    },
  };
}
