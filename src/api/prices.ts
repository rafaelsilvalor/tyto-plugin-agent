/**
 * What a turn costs, estimated from the tokens the API reports (`usage`) and the prices below.
 *
 * **An estimate, dated.** The prices are Anthropic's first-party API rates in US dollars per
 * million tokens, read on {@link PRICES_READ_ON} from Anthropic's model table, and the official
 * page is {@link PRICING_URL}. Anthropic's invoice is the bill; this is what the panel shows and
 * what the monthly cap counts. A model with no row has no estimate, and the API driver refuses to
 * run an agent on it rather than run a cap it cannot count (see `agents.ts`).
 *
 * Cache writes are the 5-minute kind, 1.25 × input. Cache reads are the per-model rate the table
 * names (0.05 × input on Claude Opus 5.5 and Claude Sonnet 5.5, 0.025 × on Claude Fable 5.2, and
 * 0.1 × elsewhere).
 */

export const PRICES_READ_ON = '2026-11-03';
export const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';

/** US dollars per million tokens. */
export interface ModelPrice {
  readonly label: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  /**
   * Above this many prompt tokens (input, cache reads and writes together) the `long` rates
   * apply instead; Claude Haiku 5.5's prices are for prompts up to 100K tokens.
   */
  readonly longAbove?: number;
  readonly long?: Omit<ModelPrice, 'label' | 'longAbove' | 'long'>;
}

/** Cache writes of the 5-minute kind cost this much of the input rate. */
export const CACHE_WRITE_FACTOR = 1.25;

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5-2': { label: 'Claude Fable 5.2', input: 8, output: 40, cacheRead: 0.2 },
  'claude-opus-5-5': { label: 'Claude Opus 5.5', input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { label: 'Claude Opus 5', input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5', input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { label: 'Claude Sonnet 5', input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': {
    label: 'Claude Haiku 5.5',
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    longAbove: 100_000,
    long: { input: 0.5, output: 2.5, cacheRead: 0.05 },
  },
};

/** The four counts of a response's `usage` that are billed. */
export interface Usage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
}

/** A call's cost in millionths of a US dollar, rounded up; `undefined` for a model with no row. */
export function costMicros(model: string, usage: Usage): number | undefined {
  const price = PRICES[model];
  if (price === undefined) return undefined;
  const read = usage.cache_read_input_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  const prompt = usage.input_tokens + read + written;
  const rates = price.longAbove !== undefined && prompt > price.longAbove ? price.long! : price;
  // Tokens × dollars per million tokens is millionths of a dollar.
  const micros =
    usage.input_tokens * rates.input +
    written * rates.input * CACHE_WRITE_FACTOR +
    read * rates.cacheRead +
    usage.output_tokens * rates.output;
  return Math.ceil(micros);
}

/** Dollars, as the panel shows them: four decimals below one cent, two above. */
export function dollars(micros: number): string {
  const value = micros / 1_000_000;
  return value < 0.01 ? value.toFixed(4) : value.toFixed(2);
}
