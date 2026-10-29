#!/usr/bin/env node

// npm `bin` entry. Calls main() unconditionally: the `import.meta.main` guard in
// release.ts needs Node 24.2+, and a bin must never silently do nothing.
import { main } from "./release.ts";

await main();
