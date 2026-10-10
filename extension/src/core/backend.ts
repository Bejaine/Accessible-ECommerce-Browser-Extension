// Backend client. VITE_BACKEND=mock (default) serves fixtures/mocks in-browser;
// any other value is the backend base URL. Called from the background script, not the page.
import type {
  ASRRequest,
  ASRResponse,
  AccessibleOutput,
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
}

const fixtures = import.meta.glob<{ default: unknown }>('@fixtures/mocks/*.json', { eager: true });

function fixture<T>(name: string): Promise<T> {
  const entry = Object.entries(fixtures).find(([path]) => path.endsWith(`/${name}.json`));
  if (!entry) return Promise.reject(new Error(`missing mock fixture ${name}`));
  return Promise.resolve(structuredClone(entry[1].default) as T);
}

export function createMockBackend(): BackendClient {
  return {
    health: () => fixture('HealthResponse'),
    prepareProduct: () => fixture('ProductPrepareResponse'),
    turn: () => fixture('TurnResponse'),
    asr: () => fixture('ASRResponse'),
    tts: () => fixture('TTSResponse'),
    translate: () => fixture('TranslateResponse'),
    ocr: () => fixture('OCRResponse'),
    describeImage: () => fixture('VisionDescribeResponse'),
    summarizeReviews: () => fixture('AccessibleOutput'),
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
  };
}

export function createBackend(setting = import.meta.env.VITE_BACKEND ?? 'mock'): BackendClient {
  return setting === 'mock' ? createMockBackend() : createHttpBackend(setting);
}
