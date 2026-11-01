import { Flamework } from "@flamework/core";

// Controllers are client-side singletons; `addPaths` is rewritten at build time into the concrete
// list of ModuleScripts under this directory. See `main.server.ts` for the ordering rule.
Flamework.addPaths("src/client/controllers");
Flamework.ignite();
