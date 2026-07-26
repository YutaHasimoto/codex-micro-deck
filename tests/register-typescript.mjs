import { registerHooks } from "node:module";

// Node's built-in type stripping does not translate the production `.js`
// specifiers back to source `.ts` files. Keep that test-only resolution here.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes("/src/") && specifier.startsWith(".") && specifier.endsWith(".js")) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});
