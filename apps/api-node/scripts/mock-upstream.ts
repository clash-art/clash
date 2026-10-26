/**
 * Thin launcher so T1 harness can `node`/`tsx` scripts/mock-upstream.ts
 * (NODES §4.2). Implementation lives in src/mock-upstream/.
 */
import { main } from "../src/mock-upstream/cli.ts";

main();
