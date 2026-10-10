// The one audio player (rule 12): a sentence queue with cached audio. STUB: queue state only.
export interface Player {
  enqueue(sentences: string[]): void;
  stop(): void;
  readonly queue: readonly string[];
}

export function createPlayer(): Player {
  let queue: string[] = [];
  return {
    enqueue(sentences) {
      queue = [...queue, ...sentences];
    },
    stop() {
      queue = [];
    },
    get queue() {
      return queue;
    },
  };
}
