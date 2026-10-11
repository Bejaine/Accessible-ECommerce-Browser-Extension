// One user turn: build a TurnRequest, call the backend, show the answer, then either run the
// safe actions or hold consequential ones until the user confirms (rules 2 and 3).
// Pending actions run only after an explicit yes; the LLM can never trigger them itself.
import type {
  AccessibleOutput,
  AsrMeta,
  ClientAction,
  Confirmation,
  ErrorCode,
  IntentAlternative,
  PageContext,
  Profile,
  TurnRequest,
} from '@shared/index';
import { label, type UiKey } from '../ui/strings';
import type { BackendClient } from './backend';
import type { TaskContinuity } from './continuity';
import { MAX_HISTORY, pushHistory, type Session } from './session';

export interface TurnInputSpec {
  kind: TurnRequest['input']['kind'];
  text?: string | null;
  phrase_id?: string | null;
  target_id?: string | null;
  asr_meta?: AsrMeta | null;
}

/**
 * What the turn loop needs from the actuator (Track B). `confirmed` is true only for
 * Confirmation.pending_actions after the user said yes; the actuator refuses committing clicks
 * without it. `reason` is an ActionFailure code ('target_not_found', 'secure_zone', ...).
 */
export type PerformFn = (
  action: ClientAction,
  opts: { confirmed: boolean },
) => Promise<{ ok: boolean; reason?: string }>;

/** Calm, specific messages for actuator failure reasons; anything else gets the generic one. */
const FAILURE_KEYS: Record<string, UiKey> = {
  target_not_found: 'action.not_found',
  target_disabled: 'action.disabled',
  secure_zone: 'action.secure_zone',
  effect_not_seen: 'action.not_seen',
};

export interface TurnDeps {
  backend: BackendClient;
  session: Session;
  getProfile: () => Profile;
  getPage: () => PageContext;
  perform: PerformFn;
  showOutput: (output: AccessibleOutput) => void;
  showConfirmation: (confirmation: Confirmation | null) => void;
  announce: (text: string, assertive?: boolean) => void;
  /** Ageing: confirm every action, not only consequential ones. */
  confirmEveryAction: () => boolean;
  /** Keeps an order task going when its step loads a new page (src/core/continuity.ts). */
  continuity?: TaskContinuity;
  /**
   * Puts personal data back into backend text before it is shown or spoken (ORDER_n → the real
   * order number, ADDR_n → the address; Track B's restorePlaceholders). Never applied to
   * anything sent back to the backend.
   */
  restore?: (text: string) => string;
}

export interface TurnPipeline {
  send(input: TurnInputSpec): Promise<void>;
  /** Next step of the order task in progress: a "Continue" turn (after its page has loaded). */
  continueTask(): Promise<void>;
  /** The two "Did you mean X or Y?" options of the last answer, when it asked. */
  readonly alternatives: readonly IntentAlternative[];
  /** The user picked option `index`: run its actions, or send its label as a phrase. */
  chooseAlternative(index: number): Promise<void>;
  /** The last turn failed with a retryable error: send it again. */
  retry(): Promise<void>;
  readonly canRetry: boolean;
  /** The user said yes / pressed the switch / pressed Yes. */
  confirm(): Promise<void>;
  cancel(): void;
  readonly pending: Confirmation | null;
  readonly busy: boolean;
}

/** A plain AccessibleOutput for messages the client produces itself (errors, help). */
export function localOutput(
  summary: string,
  lang: AccessibleOutput['lang'],
  extra: Partial<AccessibleOutput> = {},
): AccessibleOutput {
  return {
    schema_version: '1.0',
    lang,
    summary,
    sections: [],
    simpler: null,
    followups: [],
    grounding: [],
    warnings: [],
    ...extra,
  };
}

/** Calm messages per ErrorResponse code; the backend's own `error` text is never read out. */
const ERROR_KEYS: Partial<Record<ErrorCode, UiKey>> = {
  rate_limited: 'turn.busy',
  upstream_unavailable: 'turn.unavailable',
  auth_expired: 'turn.unavailable',
};

function errorShape(error: unknown): { code: string | null; retryable: boolean } {
  if (!error || typeof error !== 'object') return { code: null, retryable: true };
  const e = error as { code?: unknown; retryable?: unknown };
  return {
    code: typeof e.code === 'string' ? e.code : null,
    retryable: e.retryable === true,
  };
}

/** Every string an answer shows or speaks, with `fn` applied (grounding paths stay as they are). */
function mapOutput(output: AccessibleOutput, fn: (text: string) => string): AccessibleOutput {
  const lines = (xs: string[]) => xs.map(fn);
  return {
    ...output,
    summary: fn(output.summary),
    simpler: output.simpler === null ? null : fn(output.simpler),
    followups: lines(output.followups),
    warnings: lines(output.warnings),
    sections: output.sections.map((section) => ({
      ...section,
      heading: fn(section.heading),
      simpler: section.simpler === null ? null : fn(section.simpler),
      items: section.items.map((item) => ({ ...item, text: fn(item.text) })),
      table:
        section.table === null
          ? null
          : {
              ...section.table,
              columns: lines(section.table.columns),
              rows: section.table.rows.map(lines),
              spoken: fn(section.table.spoken),
            },
    })),
    grounding: output.grounding.map((g) => ({ ...g, claim: fn(g.claim) })),
  };
}

const CONTINUE: TurnInputSpec = { kind: 'phrase', text: 'Continue', phrase_id: 'continue' };
/** At most this many automatic "Continue" turns in a row without the user doing anything. */
const MAX_AUTO_CONTINUE = 3;
/** Let the page settle after a workflow step before reading it again. */
const SETTLE_MS = 300;

export function createTurnPipeline(deps: TurnDeps): TurnPipeline {
  let pending: Confirmation | null = null;
  let pendingInTask = false;
  let busy = false;
  let localIds = 0;
  /** True while the backend reports an order task in progress (TurnResponse.workflow). */
  let inTask = false;
  let alternatives: IntentAlternative[] = [];
  let failed: TurnInputSpec | null = null;
  let autoContinues = 0;
  const restore = deps.restore ?? ((text: string) => text);

  /** `alreadySaid`: the answer's summary was just announced; don't say the same prompt twice. */
  function setPending(confirmation: Confirmation | null, alreadySaid?: string, task = false): void {
    pending = confirmation;
    pendingInTask = confirmation !== null && task;
    const shown = confirmation && { ...confirmation, prompt: restore(confirmation.prompt) };
    deps.showConfirmation(shown);
    if (shown && shown.prompt.trim() !== alreadySaid?.trim()) {
      deps.announce(shown.prompt);
    }
  }

  /**
   * Runs actions in order and verifies each (the actuator checks expected_effect). In an order
   * task, the next page continues it: the marker is set first, because a step that navigates
   * ends this script; if this page is still here afterwards, it continues the task itself.
   */
  async function runActions(
    actions: ClientAction[],
    confirmed: boolean,
    task: boolean,
  ): Promise<boolean> {
    const continuing = task && actions.length > 0 && deps.continuity;
    if (continuing) await deps.continuity!.mark();
    for (const action of actions) {
      const result = await deps.perform(action, { confirmed });
      if (!result.ok) {
        // A navigation may still be on its way: keep the marker only for that case.
        if (continuing && result.reason !== 'effect_not_seen') await deps.continuity!.clear();
        deps.announce(label(FAILURE_KEYS[result.reason ?? ''] ?? 'action.failed'), true);
        return false;
      }
    }
    if (actions.length > 0) deps.announce(label('action.done'));
    if (continuing) {
      await deps.continuity!.clear();
      setTimeout(() => void autoContinue(), SETTLE_MS);
    }
    return true;
  }

  async function autoContinue(): Promise<void> {
    if (autoContinues >= MAX_AUTO_CONTINUE) return;
    autoContinues++;
    await turn(CONTINUE);
  }

  /** Actions from an answer or a chosen alternative: run now, or confirm first (ageing). */
  async function handleActions(actions: ClientAction[], lang: string): Promise<void> {
    if (actions.length > 0 && deps.confirmEveryAction()) {
      setPending(
        {
          schema_version: '1.0',
          id: `local-${++localIds}`,
          prompt: label('confirm.go_ahead', lang),
          risk: 'low',
          pending_actions: actions,
          read_back: null,
        },
        undefined,
        inTask,
      );
    } else {
      await runActions(actions, false, inTask);
    }
  }

  async function turn(input: TurnInputSpec): Promise<void> {
    if (busy) return;
    const page = deps.getPage();
    // The user is typing a card number, CVV, OTP or password: the mic is off and nothing is
    // sent anywhere (the backend would refuse with 423 secure_zone anyway). Stay quiet.
    if (page.secure_zone_active) return;
    busy = true;
    failed = null;
    const profile = deps.getProfile();
    const lang = profile.prefs.lang;
    const request: TurnRequest = {
      schema_version: '1.0',
      session_id: deps.session.id,
      input: {
        kind: input.kind,
        text: input.text ?? null,
        lang,
        target_id: input.target_id ?? null,
        phrase_id: input.phrase_id ?? null,
        asr_meta: input.asr_meta ?? null,
      },
      page,
      prefs: profile.prefs,
      // pushHistory keeps at most MAX_HISTORY (6) turns, matching the schema's maxItems.
      history: deps.session.history.slice(-MAX_HISTORY) as TurnRequest['history'],
    };
    try {
      const response = await deps.backend.turn(request);
      // History is English by contract; turns in other languages aren't kept (the backend
      // doesn't depend on it). Placeholders stay as the backend sent them.
      if (lang === 'en') {
        if (input.text) pushHistory(deps.session, { role: 'user', text: input.text });
        pushHistory(deps.session, { role: 'assistant', text: response.output.summary });
      }
      const wasInTask = inTask;
      inTask = response.workflow !== null;
      if (wasInTask && !inTask) void deps.continuity?.clear();
      alternatives =
        response.intent.confidence < 0.8 && response.actions.length === 0
          ? [...response.intent.alternatives]
          : [];
      const output = mapOutput(response.output, restore);
      deps.showOutput(output);

      if (response.confirmation) {
        setPending(response.confirmation, output.summary, inTask);
      } else {
        await handleActions(response.actions, lang);
      }
    } catch (error) {
      const { code, retryable } = errorShape(error);
      if (code === 'secure_zone') return; // expected; the mic is already off
      if (retryable) failed = input;
      const key = (code && ERROR_KEYS[code as ErrorCode]) || 'turn.failed';
      const message = label(key, lang);
      deps.showOutput(localOutput(message, lang as AccessibleOutput['lang']));
      deps.announce(message, true);
    } finally {
      busy = false;
    }
  }

  return {
    get pending() {
      return pending;
    },
    get busy() {
      return busy;
    },
    get alternatives() {
      return alternatives;
    },
    get canRetry() {
      return failed !== null;
    },
    async send(input) {
      autoContinues = 0; // the user did something
      await turn(input);
    },
    continueTask: () => autoContinue(),
    async chooseAlternative(index) {
      const choice = alternatives[index];
      if (!choice) return;
      alternatives = [];
      autoContinues = 0;
      if (choice.actions.length > 0)
        await handleActions(choice.actions, deps.getProfile().prefs.lang);
      else await turn({ kind: 'phrase', text: choice.label });
    },
    async retry() {
      const input = failed;
      if (input) await turn(input);
    },
    async confirm() {
      if (!pending) {
        deps.announce(label('confirm.nothing'));
        return;
      }
      const { pending_actions: actions } = pending;
      const task = pendingInTask;
      setPending(null);
      autoContinues = 0;
      await runActions(actions, true, task);
    },
    cancel() {
      if (!pending) return;
      setPending(null);
      deps.announce(label('confirm.cancelled'));
    },
  };
}
