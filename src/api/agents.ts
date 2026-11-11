import { PRICES } from './prices.js';

/**
 * The API driver's agents (TYTO-661), as configuration: each is one line of the `apiAgents`
 * setting, because a Tyto setting holds scalars and lists of them, never objects (Tyto
 * `setting-form.ts`).
 *
 *     Name | model | effort | tools | instructions
 *
 * - `model` is an API model id with a row in the price table (`prices.ts`): an agent on a model
 *   the panel cannot price is refused, so the monthly cap is never run blind.
 * - `effort` is `low`, `medium`, `high`, `xhigh` or `max`, sent as `output_config.effort`.
 * - `tools` is a comma-separated list of the window's tool names, `*` for all of them, or `-` for
 *   none. A name the window does not serve is left out, and said.
 * - `instructions` is the rest of the line, `|` included. It is the stable start of every request
 *   (the cached prefix), so it holds no date and nothing that changes per turn.
 */

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ApiAgent {
  readonly name: string;
  readonly model: string;
  readonly effort: Effort;
  /** `'*'` for every tool the window serves, otherwise the names allowed. */
  readonly tools: '*' | readonly string[];
  readonly instructions: string;
}

/**
 * Two agents to start from, after the card's example: a small model that writes briefs, and a
 * larger one that checks them.
 */
export const DEFAULT_AGENT_LINES: readonly string[] = [
  'Modelador | claude-haiku-5-5 | low | list_templates,describe_template,check_brief,brief_in_front,selection,propose_edit,proposal_status,write_brief | ' +
    'You write and fix briefs for Tyto, a compiler that renders briefs into images. Read the template with describe_template before writing for it, check every brief with check_brief, and change the brief in front only with propose_edit, which the person accepts or rejects. Answer in the language the person writes in.',
  'Revisor | claude-opus-5-5 | medium | check_brief,describe_template,brief_in_front,render_preview,propose_edit,proposal_status | ' +
    'You review briefs for Tyto. Run check_brief on the brief in front, look at render_preview when the layout matters, and propose the smallest edits that fix what you find, with propose_edit. Say what you checked and what you changed. Answer in the language the person writes in.',
];

export type AgentLine = { readonly agent: ApiAgent } | { readonly problem: string };

/** One line read, or why it is not an agent. */
export function agentOf(line: string): AgentLine {
  const parts = line.split('|');
  if (parts.length < 5) {
    return {
      problem: `"${line.slice(0, 40)}" is not Name | model | effort | tools | instructions`,
    };
  }
  const [name, model, effort, tools] = parts.slice(0, 4).map((part) => part.trim()) as [
    string,
    string,
    string,
    string,
  ];
  const instructions = parts.slice(4).join('|').trim();
  if (name === '') return { problem: 'an agent has no name' };
  if (PRICES[model] === undefined) {
    return { problem: `${name}: the panel has no price for ${model}, so it cannot keep the cap` };
  }
  if (!(EFFORTS as readonly string[]).includes(effort)) {
    return { problem: `${name}: effort ${effort} is not one of ${EFFORTS.join(', ')}` };
  }
  if (instructions === '') return { problem: `${name}: no instructions` };
  const allowed =
    tools === '*'
      ? '*'
      : tools === '-' || tools === ''
        ? []
        : tools
            .split(',')
            .map((tool) => tool.trim())
            .filter((tool) => tool !== '');
  return { agent: { name, model, effort: effort as Effort, tools: allowed, instructions } };
}

export interface Agents {
  readonly agents: readonly ApiAgent[];
  /** The lines that are not agents, said once in the panel. */
  readonly problems: readonly string[];
}

/** The configured agents; two with the same name keep the first. */
export function agentsOf(lines: readonly string[]): Agents {
  const agents: ApiAgent[] = [];
  const problems: string[] = [];
  for (const line of lines) {
    const read = agentOf(line);
    if ('problem' in read) problems.push(read.problem);
    else if (agents.some((agent) => agent.name === read.agent.name)) {
      problems.push(`${read.agent.name}: a second agent with this name is left out`);
    } else agents.push(read.agent);
  }
  return { agents, problems };
}
