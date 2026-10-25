// In-process test runner.
//
// `node --test` spawns one child process per file, which the DSH Windows sandbox
// blocks (piped stdio → EPERM). Importing the suites sequentially keeps a single
// process, so `node test/run.ts` works confined.
import "./protect.test.ts";
import "./constraints.test.ts";
import "./pipeline.test.ts";
import "./settings.test.ts";
import "./adapters.test.ts";
import "./manifest.test.ts";
