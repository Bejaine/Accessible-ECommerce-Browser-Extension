// Renderers turn AccessibleOutput into speech, large text, etc. (rule 4).
// No other module speaks or renders raw output text.
export { canSimplify, flattenSpoken, toSpokenSections } from './speech';
export type { SpeechOptions, SpokenSection } from './speech';
export { RENDER_CSS, renderOutput } from './visual';
export type { RenderOptions, RenderedOutput } from './visual';
