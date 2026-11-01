import { Flamework } from "@flamework/core";

// Flamework is a compile-time transformer: `addPaths` is rewritten into the concrete list of
// ModuleScripts under this directory in the rojo tree. Paths are source paths, not `out/` paths,
// and they must point at directories whose modules the transformer can see through the project
// file. Registering paths before `ignite()` is required — anything loaded later never runs its
// lifecycle hooks.
Flamework.addPaths("src/server/services");
Flamework.ignite();
