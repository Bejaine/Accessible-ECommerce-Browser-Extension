// One user turn: build a TurnRequest, call the backend, show the answer, then either run the
// safe actions or hold consequential ones until the user confirms (rules 2 and 3).
// Pending actions run only after an explicit yes; the LLM can never trigger them itself.
import type {
  AccessibleOutput,
  AsrMeta,
  ClientAction,
  Confirmation,
  PageContext,
  Profile,
  TurnRequest,
} from '@shared/index';
import { label, type UiKey } from '../ui/strings';
import type { BackendClient } from './backend';
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
}

export interface TurnPipeline {
  send(input: TurnInputSpec): Promise<void>;
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

function errorMessage(error: unknown): string | null {
  if (error && typeof error === 'object' && 'error' in error && typeof error.error === 'string') {
    return error.error;
  }
  return null;
}

export function createTurnPipeline(deps: TurnDeps): TurnPipeline {
  let pending: Confirmation | null = null;
  let busy = false;
  let localIds = 0;

  /** `alreadySaid`: the answer's summary was just announced; don't say the same prompt twice. */
  function setPending(confirmation: Confirmation | null, alreadySaid?: string): void {
    pending = confirmation;
    deps.showConfirmation(confirmation);
    if (confirmation && confirmation.prompt.trim() !== alreadySaid?.trim()) {
      deps.announce(confirmation.prompt);
    }
  }

  async function runActions(actions: ClientAction[], confirmed: boolean): Promise<boolean> {
    for (const action of actions) {
      const result = await deps.perform(action, { confirmed });
      if (!result.ok) {
        deps.announce(label(FAILURE_KEYS[result.reason ?? ''] ?? 'action.failed'), true);
        return false;
      }
    }
    if (actions.length > 0) deps.announce(label('action.done'));
    return true;
  }

  return {
    get pending() {
      return pending;
    },
    get busy() {
      return busy;
    },
    async send(input) {
      if (busy) return;
      busy = true;
      const profile = deps.getProfile();
      const request: TurnRequest = {
        schema_version: '1.0',
        session_id: deps.session.id,
        input: {
          kind: input.kind,
          text: input.text ?? null,
          lang: profile.prefs.lang,
          target_id: input.target_id ?? null,
          phrase_id: input.phrase_id ?? null,
          asr_meta: input.asr_meta ?? null,
        },
        page: deps.getPage(),
        prefs: profile.prefs,
        // pushHistory keeps at most MAX_HISTORY (6) turns, matching the schema's maxItems.
        history: deps.session.history.slice(-MAX_HISTORY) as TurnRequest['history'],
      };
      try {
        const response = await deps.backend.turn(request);
        if (input.text) pushHistory(deps.session, { role: 'user', text: input.text });
        pushHistory(deps.session, { role: 'assistant', text: response.output.summary });
        deps.showOutput(response.output);

        if (response.confirmation) {
          setPending(response.confirmation, response.output.summary);
        } else if (response.actions.length > 0 && deps.confirmEveryAction()) {
          setPending({
            schema_version: '1.0',
            id: `local-${++localIds}`,
            prompt: label('confirm.go_ahead', profile.prefs.lang),
            risk: 'low',
            pending_actions: response.actions,
            read_back: null,
          });
        } else {
          await runActions(response.actions, false);
        }
      } catch (error) {
        const message = errorMessage(error) ?? label('turn.failed', profile.prefs.lang);
        deps.showOutput(localOutput(message, profile.prefs.lang));
        deps.announce(message, true);
      } finally {
        busy = false;
      }
    },
    async confirm() {
      if (!pending) {
        deps.announce(label('confirm.nothing'));
        return;
      }
      const { pending_actions: actions } = pending;
      setPending(null);
      await runActions(actions, true);
    },
    cancel() {
      if (!pending) return;
      setPending(null);
      deps.announce(label('confirm.cancelled'));
    },
  };
}
