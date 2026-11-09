import type { Disposable, PluginHost } from '@tyto/plugin-api';

/**
 * The skeleton's entry: it registers nothing yet. The agent panel arrives in the plugin's first
 * pull request; this commit only sets up the repository, its checks and its contract.
 */
export function activate(_host: PluginHost): Disposable {
  return { dispose() {} };
}
