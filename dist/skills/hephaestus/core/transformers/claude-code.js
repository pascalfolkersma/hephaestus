// Claude Code transformer.
// Shell-specific: tools are serialized as a comma-separated string in the
// rendered frontmatter (Claude Code's actual format), not a YAML list.

import { parseAgentSource, renderAgent } from './_shared.js';

export { parseAgentSource };

export async function transform(args) {
  return renderAgent(args, { toolsFormat: 'comma-string' });
}
