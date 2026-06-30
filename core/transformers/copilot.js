// GitHub Copilot transformer.
// Shell-specific: tools are serialized as a YAML list in the rendered
// frontmatter, and shell-specific extras (target, handoffs) round-trip
// from the source's `copilot:` namespace via the shared frontmatter builder.

import { parseAgentSource, renderAgent } from './_shared.js';

export { parseAgentSource };

export async function transform(args) {
  return renderAgent(args, { toolsFormat: 'yaml-list' });
}
