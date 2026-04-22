// Side-effect module: loads .env from the agent directory before any other
// module-level code runs. MUST be imported FIRST in run.js — before any module
// that does `new Anthropic()` or otherwise reads process.env at import time.
//
// Why this exists: ES module imports are hoisted, so a `config()` call placed
// after `import ingest from './ingest.js'` in run.js runs AFTER ingest.js (and
// its transitive imports like planning-agendas.js, prefilter.js, evaluate.js)
// have already instantiated their top-level Anthropic clients with an empty
// process.env.ANTHROPIC_API_KEY. Putting dotenv in its own side-effect import
// guarantees it runs before any sibling import in the same file.

import { config } from 'dotenv'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '.env') })
