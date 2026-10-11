// The content-script app: overlay, renderers, controls, turns and confirmations, on-device
// inference and suggestions, wired to the bus and the profile store. Integration lead owns this.
//
// Input routes:
// - phrase chips, suggestion chips, scan selections, typed/spoken text (`say`)
// - local commands first (yes / no / repeat / help / slower / faster / undo): no server call
// - everything else becomes a turn (TurnRequest -> backend -> output, actions, confirmation)
import type {
  AccessibleOutput,
  AsrMeta,
  CheckoutSummary,
  PageContext,
  Profile,
} from '@shared/index';
import { browser } from 'wxt/browser';
import { performAction } from '../actuate';
import { createBargeIn, type BargeIn } from '../audio/bargeIn';
import { createMic, MicError, toAsrRequest, type Mic, type Utterance } from '../audio/mic';
import { phraseAudioUrl } from '../audio/phrases';
import { createPlayer, type Player } from '../audio/player';
import { createSpeechSources } from '../audio/sources';
import {
  completeWithFallback,
  extractPageContext,
  muteMicInSecureZone,
  resolveTarget,
  restorePlaceholders,
} from '../extract';
import { t } from '../i18n';
import { attachCollectors } from '../infer/collectors';
import { createScoreEngine, type InferredCondition, type ScoreEngine } from '../infer/scores';
import { createSuggester, type Suggester } from '../infer/suggest';
import { buildCandidates, createMatcher } from '../match';
import { renderOutput, type RenderedOutput } from '../render';
import { announce, resetAnnouncer, setAnnounceVoice } from '../ui/announce';
import { createConfirmCard, formatMoney } from '../ui/confirmCard';
import { createMicButton } from '../ui/micButton';
import { createActiveFeatures } from '../ui/activeFeatures';
import { createMenuSection, createTurnStatus, createTypeBox } from '../ui/menu';
import { createSettings } from '../ui/settings';
import {
  createPlaybackBar,
  MINI_MENU,
  miniMenuLabel,
  type PlaybackAction,
} from '../ui/playbackBar';
import { createScanner } from '../ui/scanner';
import { attachDwell, type Dwell } from '../ui/dwell';
import { createActionMenu } from '../ui/actionMenu';
import { createColourLabels, type ColourLabels } from '../ui/colourLabels';
import { renderSimpleView, simpleSummary } from '../ui/simpleView';
import { createCheckoutWizard } from '../ui/checkoutWizard';
import { createControls, type Controls } from '../ui/controls';
import { BACKEND_CHIPS, PHRASES, phraseLabel } from '../ui/phrases';
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
  interruptBySpeaking,
  spaceToSpeak,
  OPEN_ONBOARDING,
  saveDevicePrefs,
  type DevicePrefs,
  type ProfileStore,
} from './profile';
import { createInputFallback } from './fallback';
import type { TaskContinuity } from './continuity';
import { createSession } from './session';
import { createPlayerSpeaker, type Speaker } from './voice';
import { playerEngines } from './deviceVoice';
import { createResumeStore } from './resume';
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

const LANGUAGE_NAMES = { en: 'English', hi: 'हिंदी', te: 'తెలుగు' } as const;

/** Typing a space in a text field must never count as a switch press. */
function isEditable(target: EventTarget | undefined): boolean {
  const el = target instanceof HTMLElement ? target : null;
  return Boolean(el && (el.isContentEditable || el.closest('input, textarea, select')));
}

/** Simple mode's text size (Prefs.text_scale), applied when the mode turns on. */
export const SIMPLE_TEXT_SCALE = 1.25;

/** Controls that Space already presses (buttons, links, checkboxes…): Space stays theirs. */
const SPACE_OWNERS =
  'button, a[href], summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], ' +
  '[role="switch"], [role="menuitem"], [role="tab"], [role="option"], [role="slider"]';
function ownsSpace(target: EventTarget | undefined): boolean {
  const el = target instanceof Element ? target : null;
  return Boolean(el && (isEditable(el) || el.closest(SPACE_OWNERS)));
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
  /** Continue the order task the previous page started (says so, then a "Continue" turn). */
  continueTask(): Promise<void>;
  /** Step-by-step checkout for the page's summary (or a given one, e.g. a fixture in dev). */
  showCheckout(summary?: CheckoutSummary): void;
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
  /** The shopping session shared by every page (from the background; src/core/continuity.ts). */
  sessionId?: string;
  /** Keeps an order task going across page loads; without it tasks stop at a page change. */
  continuity?: TaskContinuity;
  /** The previous page took an order-task step: continue it here (no "resume reading" offer). */
  continueTask?: boolean;
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
  const session = createSession(options.sessionId);
  const offs: (() => void)[] = [];
  let profile = store.get();
  let mode = resolveMode(profile);
  let lastOutput: AccessibleOutput | null = null;
  const lang = () => profile.prefs.lang;

  // --- The assistant's own voice (users without a screen reader) ---
  // All audio goes through Track A's player (rule 12): server TTS (Bhashini) with a per-text
  // cache and pre-recorded UI phrases, or the device voice in demo/lite mode or as a fallback.
  let player: Player | null = null;
  if (!options.speaker) {
    const sources = createSpeechSources({
      tts: (text, l) => backend.tts({ schema_version: '1.0', text, lang: l }),
      lite: () => demo || profile.prefs.lite_mode,
      phraseUrl: phraseAudioUrl,
      onFallback: () => announce(t('lite.device_voice', lang()), { speak: false }),
    });
    // The device voice pauses by stopping and repeating the sentence (src/core/deviceVoice.ts).
    player = createPlayer({ sources, rate: profile.prefs.tts_rate, engines: playerEngines() });
  }
  const speaker: Speaker =
    options.speaker ??
    createPlayerSpeaker(player!, {
      // Say once (as text) that a language has no voice here; the text stays on screen.
      onNoVoice: (l) =>
        announce(label('voice.missing', lang()).replaceAll('{language}', LANGUAGE_NAMES[l]), {
          speak: false,
        }),
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
  /** While an answer (or another view) is open, the menu shrinks to the status and Ask. */
  function setAnswering(on: boolean, settingsPage = false): void {
    overlay.controls.classList.toggle('asl-answering', on);
    overlay.controls.classList.toggle('asl-settings-open', on && settingsPage);
  }

  function showOutput(output: AccessibleOutput): void {
    lastOutput = output;
    setAnswering(true);
    // "Did you mean X or Y?" options are shown once, as the two big buttons, not also as chips.
    const options = new Set(turn.alternatives.map((a) => a.label.trim().toLowerCase()));
    const shown =
      options.size > 0
        ? {
            ...output,
            followups: output.followups.filter((f) => !options.has(f.trim().toLowerCase())),
          }
        : output;
    view = renderOutput(overlay.content, shown, {
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
    setAnswering(false);
    // Back to the top of the menu: the Speak button (never a hidden status button).
    overlay.controls.querySelector<HTMLElement>('.asl-mic')?.focus();
  }

  // --- Turns and confirmations ---
  const confirmCard = createConfirmCard({
    onYes: () => void turn.confirm(),
    onNo: () => turn.cancel(),
  });
  // "Did you mean…", "Try again" and the order task's step, above everything else.
  const turnStatus = createTurnStatus({
    onChoose: (i) => void turn.chooseAlternative(i),
    onRetry: () => void turn.retry(),
  });
  function renderTurnStatus(): void {
    const { question, step } = turnStatus.render({
      alternatives: turn.alternatives,
      canRetry: turn.canRetry,
      workflow: turn.workflow,
    });
    // The answer usually asks the question itself; only say it when it didn't.
    const summary = lastOutput?.summary.toLowerCase() ?? '';
    const asked = turn.alternatives.every((a) => summary.includes(a.label.toLowerCase()));
    if (question && !asked) announce(question);
    if (step) announce(step);
  }
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
      // The card has the Yes / No buttons; the answer's own yes/no chips would only repeat them.
      const chips = overlay.content.querySelector<HTMLElement>('.asl-followups');
      if (chips) chips.hidden = confirmation !== null;
    },
    announce: (text, assertive) => announce(text, { assertive }),
    confirmEveryAction: () => confirmEveryAction(profile),
    continuity: options.continuity,
    // ORDER_n / ADDR_n back to the real order number and address, on the device only.
    restore: (text) => restorePlaceholders(text),
    onUpdate: () => renderTurnStatus(),
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
    onBack: () => backToMenu(),
    onStartScanning: () => {
      overlay.open();
      backToMenu();
      refreshPageTools();
      controls.startScanning(actionMenu.actions);
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
    spaceToSpeak: {
      get: () => spaceToSpeak(devicePrefs),
      set: (on) => {
        devicePrefs.spaceToSpeak = on;
        void saveDevicePrefs(devicePrefs);
      },
    },
    interrupt: {
      get: () => interruptBySpeaking(devicePrefs),
      set: (on) => {
        devicePrefs.interruptBySpeaking = on;
        void saveDevicePrefs(devicePrefs);
      },
    },
    dwell: {
      get: () => devicePrefs.dwellMs ?? null,
      set: (ms) => {
        devicePrefs.dwellMs = ms;
        setDwell(ms);
        void saveDevicePrefs(devicePrefs);
      },
    },
  });

  // --- Dwell to click (opt-in; only the assistant's own controls) ---
  let dwell: Dwell | null = null;
  function setDwell(ms: number | null): void {
    if (ms === null) {
      dwell?.detach();
      dwell = null;
    } else if (dwell) {
      dwell.setTime(ms);
    } else {
      dwell = attachDwell(overlay.content.getRootNode() as ShadowRoot | Document, ms);
    }
  }
  setDwell(devicePrefs.dwellMs ?? null);
  offs.push(() => setDwell(null));
  settings.render(profile, mode);
  // --- Page tools: simplified view, action menu, colour labels ---
  const pageTools = document.createElement('div');
  pageTools.className = 'asl-list';
  const simpleButton = document.createElement('button');
  simpleButton.type = 'button';
  simpleButton.className = 'asl-menu-toggle';
  simpleButton.textContent = label('simple.open');
  simpleButton.addEventListener('click', () => showSimpleView());
  // Curated: one entry per destination, main actions first (src/ui/pageActions.ts).
  const actionMenu = createActionMenu((target) => bus.emit({ type: 'select-target', target }), {
    hrefOf: (id) => resolveTarget(id)?.getAttribute('href') ?? null,
    display: (text) => restorePlaceholders(text),
  });
  const checkoutButton = document.createElement('button');
  checkoutButton.type = 'button';
  checkoutButton.className = 'asl-menu-toggle';
  checkoutButton.textContent = label('checkout.open');
  checkoutButton.addEventListener('click', () => showCheckout());
  pageTools.append(simpleButton, checkoutButton, actionMenu.element);
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
    const previous = page;
    page = extractPageContext();
    // Typing a card number or CVV: nothing is read from the page then (secure zone), so keep the
    // checkout summary read before (it holds no payment details) instead of hiding the steps.
    if (page.secure_zone_active && !page.checkout && previous.checkout) {
      page = { ...page, checkout: previous.checkout };
    }
    actionMenu.render(page.targets);
    simpleButton.hidden = !(page.page_type === 'product' && page.products[0]);
    checkoutButton.hidden = !page.checkout;
    pageSection.setHidden(
      simpleButton.hidden &&
        checkoutButton.hidden &&
        !page.targets.some((t) => !t.state?.disabled && t.label.trim()),
    );
    typeBox.setSuggestions([
      ...PHRASES.map((p) => phraseLabel(p.id, lang())),
      ...page.targets.filter((t) => !t.state?.disabled).map((t) => t.label),
      ...page.products.map((p) => p.title ?? ''),
    ]);
    updateColourLabels();
  }

  /** True while the panel opens by itself (simple mode on page load): don't move focus. */
  let quietOpen = false;

  function showSimpleView(): void {
    const product = page.page_type === 'product' ? page.products[0] : undefined;
    if (!product) return;
    speaker.stop();
    view = null;
    overlay.setWide(true);
    setAnswering(true);
    overlay.content.replaceChildren(
      renderSimpleView(product, page.targets, {
        onSelect: (target) => bus.emit({ type: 'select-target', target }),
        onBack: backToMenu,
        maxActions: mode.max_options,
      }),
    );
    overlay.content.querySelector<HTMLElement>('h3')?.setAttribute('tabindex', '-1');
    if (!quietOpen) overlay.content.querySelector<HTMLElement>('h3')?.focus();
    announce(simpleSummary(product));
  }

  function showSettings(): void {
    view = null;
    overlay.setWide(false);
    setAnswering(true, true);
    overlay.content.replaceChildren(settings.element);
    settings.element.querySelector<HTMLElement>('h3')?.focus();
  }

  /** Step-by-step checkout from PageContext.checkout (simple mode opens it directly). */
  function showCheckout(override?: CheckoutSummary): void {
    const summary = override ?? page.checkout;
    if (!summary) return;
    speaker.stop();
    view = null;
    overlay.setWide(true);
    const changeAddress = page.targets.find(
      (t) => /address/i.test(t.label) && t.zone === 'checkout',
    );
    const wizard = createCheckoutWizard(summary, {
      prefs: profile.prefs,
      changeAddressTargetId: changeAddress?.id ?? null,
      // Track C's /turn maps "place my order" to the place-order task: it reads the order back
      // and returns a high-risk confirmation. Nothing is pressed until the user says yes.
      onPlaceOrder: () =>
        void turn.send({
          kind: 'phrase',
          phrase_id: BACKEND_CHIPS.place_order,
          text: BACKEND_CHIPS.place_order,
        }),
      onTarget: (id) => {
        const target = page.targets.find((t) => t.id === id);
        if (target) bus.emit({ type: 'select-target', target });
      },
      onBack: backToMenu,
      announce: (text) => announce(text),
    });
    setAnswering(true);
    overlay.content.replaceChildren(wizard.element);
    // Focus and announce the first step now that it's attached (opened by itself: just say so).
    if (quietOpen) announce(label('checkout.open'));
    else wizard.go('items');
  }

  offs.push(
    overlay.onOpen(() => {
      refreshPageTools();
      // Simple mode opens straight into the simplified product view or the checkout steps.
      if (profile.conditions.ageing.active && !overlay.content.hasChildNodes()) {
        if (page.checkout) showCheckout();
        else showSimpleView();
      }
    }),
    () => colourLabels?.destroy(),
  );

  // --- Menu layout: status, then labelled sections in a fixed order (src/ui/menu.ts) ---
  const status = document.createElement('div');
  status.className = 'asl-status';
  status.append(confirmCard.element, suggestionCard.element, turnStatus.element);
  const typeBox = createTypeBox((text) => void say(text, 'text'));
  const askSection = createMenuSection('menu.ask', [typeBox.element], 'asl-ask');
  const phraseSlot = document.createElement('div');
  phraseSlot.style.display = 'contents';
  const quickSection = createMenuSection('menu.quick', [phraseSlot]);
  const pageSection = createMenuSection('menu.page', [pageTools]);
  speed.element.classList.add('asl-row');
  const readingSection = createMenuSection('menu.reading', [speed.element]);
  // Settings is its own page in the panel (like an answer), opened from this row.
  const settingsGroup = document.createElement('div');
  settingsGroup.className = 'asl-group asl-list';
  settingsGroup.append(settings.button);
  settings.button.addEventListener('click', () => showSettings());
  overlay.controls.append(
    status,
    askSection.element,
    quickSection.element,
    pageSection.element,
    readingSection.element,
    settingsGroup,
  );

  // --- Phrase board and switch scanning (rebuilt when the mode changes) ---
  function buildControls(p: Profile): Controls {
    const c = createControls({
      container: phraseSlot,
      barContainer: status,
      // "Did you mean…" options are scanned first while they are offered.
      extraGroups: () =>
        turnStatus.optionButtons.length > 0
          ? [
              {
                id: 'alternatives',
                label: label('alt.title', lang()),
                items: turnStatus.optionButtons.map((b, i) => ({
                  id: `alt-${i}`,
                  label: b.textContent ?? '',
                  activate: () => b.click(),
                })),
              },
            ]
          : [],
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

  // Which accessibility features are on, in a small note in the corner (rule 5: visible, undoable).
  const activeFeatures = createActiveFeatures({
    onChange: () => {
      overlay.open();
      showSettings();
    },
  });
  overlay.floating.append(activeFeatures.element);
  activeFeatures.render(profile);
  offs.push(store.subscribe((next) => activeFeatures.render(next)));
  offs.push(speaker.onChange((_, state, sentence) => playbackBar.update(state, sentence)));

  // Resume where it stopped after a page change: keep the answer's position on the device while
  // it plays; on the next page of this site, hold it as a paused answer and say how to resume.
  const resume = createResumeStore(location.hostname);
  let savedAt = '';
  offs.push(
    speaker.onChange(() => {
      if (speaker.state === 'idle') {
        savedAt = '';
        resume.clear();
        return;
      }
      const snap = speaker.snapshot();
      if (!snap) return;
      const at = `${speaker.state}|${snap.sections.length}|${snap.section}|${snap.index}`;
      if (at === savedAt) return;
      savedAt = at;
      resume.save(snap);
    }),
  );
  // During an order task the next page continues it instead (one voice at a time).
  void resume.take().then((snap) => {
    if (!snap || speaker.state !== 'idle' || options.continueTask) return;
    speaker.offerResume(snap);
    announce(label('playback.resume_offer', lang()));
  });

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
      case 'first':
      case 'second':
      case 'alt:0':
      case 'alt:1': {
        const i = id === 'first' || id === 'alt:0' ? 0 : 1;
        if (!turn.alternatives[i]) return false;
        void turn.chooseAlternative(i);
        return true;
      }
      case 'retry':
        if (!turn.canRetry) return false;
        void turn.retry();
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
      buildCandidates({
        targets: current.targets,
        products: current.products,
        alternatives: turn.alternatives.map((a) => a.label),
      }),
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

  const preparing = new Set<string>();

  function preparePage(): void {
    const product =
      page.page_type === 'product' && !page.secure_zone_active ? page.products[0] : undefined;
    if (!product || prepared.has(product.id) || preparing.has(product.id)) return;
    preparing.add(product.id);
    // Read-aloud users hear title and price from the page at once (grounded in ProductJSON).
    if (profile.conditions.visual.active && product.title) {
      const price = product.price ? formatMoney(product.price, lang()) : null;
      announce(price ? `${product.title}. ${price}.` : product.title);
    }
    void (async () => {
      let full = product;
      // Track B's tier 3: ask /extract/fallback for fields the page's own tiers missed, and
      // learn where they were for the next page of this site. Never in demo mode: the mock
      // answers for the fixture phone, not this page (rule 1).
      if (!demo) {
        try {
          full = await completeWithFallback(
            document,
            product,
            (req) => backend.extractFallback(req),
            browser.storage.local,
          );
          const i = page.products.findIndex((p) => p.id === product.id);
          if (i >= 0) page.products[i] = full;
        } catch {
          // Keep what the page gave us; the fields stay listed in `missing`.
        }
      }
      try {
        const res = await backend.prepareProduct({
          schema_version: '1.0',
          product: full,
          prefs: profile.prefs,
          // The shopping session, so a product only opened (no turn) can be compared later.
          session_id: session.id,
        });
        prepared.set(product.id, res.sections);
      } catch {
        // Section phrases fall back to a turn.
      } finally {
        preparing.delete(product.id);
      }
    })();
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

  // --- Simple mode (ageing): once the mode is on, its accommodations apply by themselves ---
  // Larger text when it turns on (restored when it turns off, unless the user changed it), and
  // on product and checkout pages the panel opens straight into the simplified view or the
  // checkout steps, without moving keyboard focus.
  function openForSimpleMode(): void {
    if (!profile.conditions.ageing.active || overlay.isOpen) return;
    refreshPageTools();
    const useful = (page.page_type === 'product' && page.products[0]) || page.checkout;
    if (!useful) return;
    quietOpen = true;
    try {
      overlay.open({ focus: false });
    } finally {
      quietOpen = false;
    }
  }
  async function simpleModeChanged(on: boolean): Promise<void> {
    devicePrefs.simpleApplied = on;
    if (on) {
      openForSimpleMode();
      if (profile.prefs.text_scale < SIMPLE_TEXT_SCALE) {
        devicePrefs.textScaleBeforeSimple = profile.prefs.text_scale;
        await store.update((d) => {
          d.prefs.text_scale = SIMPLE_TEXT_SCALE;
        });
      }
      void saveDevicePrefs(devicePrefs);
    } else {
      const before = devicePrefs.textScaleBeforeSimple;
      if (typeof before === 'number' && profile.prefs.text_scale === SIMPLE_TEXT_SCALE) {
        await store.update((d) => {
          d.prefs.text_scale = before;
        });
      }
      devicePrefs.textScaleBeforeSimple = null;
      void saveDevicePrefs(devicePrefs);
    }
  }
  let simpleOn = profile.conditions.ageing.active;
  offs.push(
    store.subscribe((next) => {
      if (next.conditions.ageing.active === simpleOn) return;
      simpleOn = next.conditions.ageing.active;
      void simpleModeChanged(simpleOn);
    }),
  );
  // Already in simple mode when the page loads: apply it once on this device (bigger text);
  // after that the user's own text size is kept. The panel opens into the simple view either way.
  if (simpleOn && !devicePrefs.simpleApplied) void simpleModeChanged(true);
  else openForSimpleMode();

  // --- Voice (Track A's microphone): listen -> /speech/asr -> local fast path or a turn ---
  let fallback = createInputFallback(mode);
  offs.push(store.subscribe(() => (fallback = createInputFallback(mode))));
  const micButton = createMicButton(() => void listen());
  askSection.element.querySelector('h3')!.after(micButton.element);

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

  /** ASR, then the local matcher or a turn. False if nothing usable was heard. */
  async function handleUtterance(utterance: Utterance, duringPlayback = false): Promise<boolean> {
    const asr = await backend.asr(toAsrRequest(utterance, lang()));
    // The mic heard the assistant's own voice (speakers, no headphones): drop it, carry on reading.
    if (duringPlayback && bargeIn?.isEcho(asr.text)) return false;
    if (!asr.text.trim()) {
      if (utterance.micLevel > 0.1) engine.add('unheard_speech');
      notUnderstood();
      return false;
    }
    fallback.recordSuccess();
    await say(asr.text, 'voice', asr.asr_meta);
    return true;
  }

  // Barge-in (Track A): speaking during playback pauses it and the words are handled like any
  // utterance. Only after the user has used Speak once, so the mic permission prompt never
  // appears out of the blue while an answer is being read.
  let bargeIn: BargeIn | null = null;
  function enableBargeIn(): void {
    if (bargeIn || !player || demo) return;
    bargeIn = createBargeIn({
      mic,
      player,
      mode: () => (profile.conditions.speech.active ? 'speech' : 'default'),
      // Off unless the user wants it (Settings): on a phone speaker the mic hears the answer.
      enabled: () => interruptBySpeaking(devicePrefs),
      onUtterance: (utterance) => {
        if (!utterance.audioBase64) return;
        void handleUtterance(utterance, true)
          .then((heard) => heard || bargeIn?.resumeAfterBargeIn())
          .catch(() => bargeIn?.resumeAfterBargeIn());
      },
    });
    offs.push(() => bargeIn?.dispose());
  }

  // Secure zone (Track B detects, Track A mutes): in password, card, CVV, OTP or UPI fields the
  // mic is off and nothing is extracted; listening resumes when focus leaves (docs/safety.md).
  const secureZone = muteMicInSecureZone(document, mic, (event) =>
    announce(t(event === 'entered' ? 'mic.secure_zone' : 'listening.resumed', lang()), {
      assertive: event === 'entered',
    }),
  );
  offs.push(() => secureZone.stop());

  async function listen(): Promise<void> {
    if (mic.listening) {
      mic.stop();
      return;
    }
    if (demo) {
      // The mock backend can't recognise speech: say so instead of pretending to listen, and
      // offer typing right away.
      announce(label('mic.demo', lang()), { assertive: true });
      typeBox.input.focus();
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
      if (await handleUtterance(utterance)) enableBargeIn();
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
      // Track C answers its chips without the LLM, keyed by its own chip names.
      else void turn.send({ kind: 'phrase', phrase_id: BACKEND_CHIPS[m.id] ?? null, text: m.text });
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
    const target = e.composedPath()[0];
    const isSwitch = e.code === profile.prefs.switch_key && !isEditable(target);
    const suggestionWaiting =
      suggester.state.kind === 'countdown' || suggester.state.kind === 'question';
    // Space to speak (the single key for voice): when nothing else is waiting for a key, and not
    // while typing, on a control Space presses, or during switch scanning (Space is the switch).
    if (
      e.code === 'Space' &&
      !e.repeat &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      spaceToSpeak(devicePrefs) &&
      !turn.pending &&
      !suggestionWaiting &&
      !controls.scanning &&
      !ownsSpace(target)
    ) {
      e.preventDefault();
      e.stopImmediatePropagation();
      void listen();
      return;
    }
    if (e.key !== 'Escape' && !isSwitch) return;
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
    showCheckout: (summary) => {
      overlay.open();
      showCheckout(summary);
    },
    async continueTask() {
      announce(label('task.continuing', lang()));
      await turn.continueTask();
    },
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
