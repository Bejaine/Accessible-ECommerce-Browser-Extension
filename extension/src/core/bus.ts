// Message bus: typed in-page pub/sub plus a bridge to the background service worker.
// Integration lead owns the message list; add new message types here, never ad-hoc strings.
import type {
  AccessibleOutput,
  ActionTarget,
  ProductPrepareRequest,
  ProductPrepareResponse,
  TurnRequest,
  TurnResponse,
} from '@shared/index';

export type BusMessage =
  | { type: 'announce'; text: string; assertive?: boolean }
  | { type: 'output'; output: AccessibleOutput }
  | { type: 'followup'; text: string }
  | { type: 'phrase'; id: string; text: string }
  | { type: 'select-target'; target: ActionTarget }
  | { type: 'turn'; request: TurnRequest }
  | { type: 'turn-result'; response: TurnResponse }
  | { type: 'prepare'; request: ProductPrepareRequest }
  | { type: 'prepare-result'; response: ProductPrepareResponse };

export type BusType = BusMessage['type'];
export type MessageOf<T extends BusType> = Extract<BusMessage, { type: T }>;
type Handler<T extends BusType> = (msg: MessageOf<T>) => void;

export interface Bus {
  on<T extends BusType>(type: T, handler: Handler<T>): () => void;
  emit(msg: BusMessage): void;
}

export function createBus(): Bus {
  const handlers = new Map<BusType, Set<(msg: BusMessage) => void>>();
  return {
    on(type, handler) {
      const set = handlers.get(type) ?? new Set();
      const h = handler as (msg: BusMessage) => void;
      set.add(h);
      handlers.set(type, set);
      return () => set.delete(h);
    },
    emit(msg) {
      handlers.get(msg.type)?.forEach((h) => h(msg));
    },
  };
}

/** Shared bus for the content script. */
export const bus = createBus();
