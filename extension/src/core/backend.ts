// Backend client. VITE_BACKEND=mock (default) serves fixtures/mocks in-browser;
// any other value is the backend base URL. Called from the background script, not the page.
import type {
  ASRRequest,
  ASRResponse,
  AccessibleOutput,
  ExtractFallbackRequest,
  ExtractFallbackResponse,
  HealthResponse,
  OCRRequest,
  OCRResponse,
  ProductPrepareRequest,
  ProductPrepareResponse,
  ReviewsSummarizeRequest,
  TranslateRequest,
  TranslateResponse,
  TTSRequest,
  TTSResponse,
  TurnRequest,
  TurnResponse,
  VisionDescribeRequest,
  VisionDescribeResponse,
} from '@shared/index';

export interface BackendClient {
  health(): Promise<HealthResponse>;
  prepareProduct(req: ProductPrepareRequest): Promise<ProductPrepareResponse>;
  turn(req: TurnRequest): Promise<TurnResponse>;
  asr(req: ASRRequest): Promise<ASRResponse>;
  tts(req: TTSRequest): Promise<TTSResponse>;
  translate(req: TranslateRequest): Promise<TranslateResponse>;
  ocr(req: OCRRequest): Promise<OCRResponse>;
  describeImage(req: VisionDescribeRequest): Promise<VisionDescribeResponse>;
  summarizeReviews(req: ReviewsSummarizeRequest): Promise<AccessibleOutput>;
  /** Tier-3 extraction for Track B (built and merged in src/extract/llm.ts). */
  extractFallback(req: ExtractFallbackRequest): Promise<ExtractFallbackResponse>;
}

const fixtures = import.meta.glob<{ default: unknown }>('@fixtures/mocks/*.json', { eager: true });

function fixture<T>(name: string): Promise<T> {
  const entry = Object.entries(fixtures).find(([path]) => path.endsWith(`/${name}.json`));
  if (!entry) return Promise.reject(new Error(`missing mock fixture ${name}`));
  return Promise.resolve(structuredClone(entry[1].default) as T);
}

/** Shown on every mock answer: fixtures describe a fictional product, never the open page. */
export const MOCK_WARNING = 'Demo data from test fixtures, not from this page.';

const withMockWarning = (output: AccessibleOutput): AccessibleOutput => ({
  ...output,
  warnings: [...output.warnings, MOCK_WARNING],
});

type Section = 'overview' | 'specs' | 'reviews' | 'images';

/** Which prepared fixture section answers a turn (mock only; the real backend decides itself). */
function mockSectionFor(req: TurnRequest): Section | 'add_to_cart' | null {
  const { phrase_id: phrase, target_id: target, text } = req.input;
  const said = (text ?? '').toLowerCase();
  if (phrase === 'add to cart' || target === 't-add-to-cart' || said.includes('add to cart')) {
    return 'add_to_cart';
  }
  if (phrase === 'reviews' || said.includes('review')) return 'reviews';
  if (phrase === 'specs' || said.includes('spec')) return 'specs';
  if (phrase === 'price' || phrase === 'where am i?' || said.includes('price')) return 'overview';
  if (said.includes('box') || said.includes('image') || said.includes('photo')) return 'images';
  return null;
}

export function createMockBackend(): BackendClient {
  return {
    health: () => fixture('HealthResponse'),
    async prepareProduct() {
      const res = await fixture<ProductPrepareResponse>('ProductPrepareResponse');
      for (const key of Object.keys(res.sections) as (keyof typeof res.sections)[]) {
        const section = res.sections[key];
        if (section) res.sections[key] = withMockWarning(section);
      }
      return res;
    },
    async turn(req) {
      const target = mockSectionFor(req);
      if (target === 'add_to_cart') {
        const res = await fixture<TurnResponse>('TurnResponse');
        return { ...res, output: withMockWarning(res.output) };
      }
      const prepared = await this.prepareProduct({} as ProductPrepareRequest);
      const output = target ? prepared.sections[target] : null;
      return {
        schema_version: '1.0',
        intent: {
          name: target ? `describe_${target}` : 'unknown',
          confidence: 1,
          alternatives: [],
        },
        actions: [],
        confirmation: null,
        workflow: null,
        output:
          output ??
          withMockWarning({
            schema_version: '1.0',
            lang: 'en',
            summary: 'Demo mode has no answer for that yet.',
            sections: [],
            simpler: null,
            followups: ['What do reviews say?', 'Tell me the specs', 'Add to cart'],
            grounding: [],
            warnings: [],
          }),
      };
    },
    asr: () => fixture('ASRResponse'),
    tts: () => fixture('TTSResponse'),
    translate: () => fixture('TranslateResponse'),
    ocr: () => fixture('OCRResponse'),
    async describeImage() {
      const res = await fixture<VisionDescribeResponse>('VisionDescribeResponse');
      return { ...res, output: withMockWarning(res.output) };
    },
    async summarizeReviews() {
      return withMockWarning(await fixture<AccessibleOutput>('AccessibleOutput'));
    },
    extractFallback: () => fixture('ExtractFallbackResponse'),
  };
}

export function createHttpBackend(baseUrl: string): BackendClient {
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(new URL(path, baseUrl), {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // Errors are {error, code, retryable}; callers turn them into a calm spoken message.
    if (!res.ok) throw await res.json();
    return (await res.json()) as T;
  }
  return {
    health: () => call('GET', '/health'),
    prepareProduct: (req) => call('POST', '/product/prepare', req),
    turn: (req) => call('POST', '/turn', req),
    asr: (req) => call('POST', '/speech/asr', req),
    tts: (req) => call('POST', '/speech/tts', req),
    translate: (req) => call('POST', '/translate', req),
    ocr: (req) => call('POST', '/ocr', req),
    describeImage: (req) => call('POST', '/vision/describe', req),
    summarizeReviews: (req) => call('POST', '/reviews/summarize', req),
    extractFallback: (req) => call('POST', '/extract/fallback', req),
  };
}

export function createBackend(setting = import.meta.env.VITE_BACKEND ?? 'mock'): BackendClient {
  return setting === 'mock' ? createMockBackend() : createHttpBackend(setting);
}

export const BACKEND_METHODS = [
  'health',
  'prepareProduct',
  'turn',
  'asr',
  'tts',
  'translate',
  'ocr',
  'describeImage',
  'summarizeReviews',
  'extractFallback',
] as const satisfies readonly (keyof BackendClient)[];

export type BackendMethod = (typeof BACKEND_METHODS)[number];

export interface BackendRequestMessage {
  type: 'backend';
  method: BackendMethod;
  request?: unknown;
}

/** Backend result relayed by the background script: a value or an ErrorResponse-shaped error. */
export type BackendReply = { ok: true; value: unknown } | { ok: false; error: unknown };

/**
 * For the content script: every call goes through the background script, so page CSPs and CORS
 * never apply and the backend URL stays out of the page.
 */
export function createRuntimeBackend(
  send: (message: BackendRequestMessage) => Promise<BackendReply>,
): BackendClient {
  const call =
    (method: BackendMethod) =>
    async (request?: unknown): Promise<never> => {
      const reply = await send({ type: 'backend', method, request });
      if (!reply.ok) throw reply.error;
      return reply.value as never;
    };
  return Object.fromEntries(BACKEND_METHODS.map((m) => [m, call(m)])) as unknown as BackendClient;
}

/** Background side: run one relayed call, turning failures into the {error, code, retryable} shape. */
export async function handleBackendMessage(
  backend: BackendClient,
  message: BackendRequestMessage,
): Promise<BackendReply> {
  if (!BACKEND_METHODS.includes(message.method)) {
    return {
      ok: false,
      error: { error: 'Unknown request.', code: 'validation', retryable: false },
    };
  }
  try {
    const fn = backend[message.method] as (req?: unknown) => Promise<unknown>;
    return { ok: true, value: await fn.call(backend, message.request) };
  } catch (error) {
    const shaped =
      error && typeof error === 'object' && 'code' in error
        ? error
        : {
            error: 'The assistant could not be reached.',
            code: 'upstream_unavailable',
            retryable: true,
          };
    return { ok: false, error: shaped };
  }
}
