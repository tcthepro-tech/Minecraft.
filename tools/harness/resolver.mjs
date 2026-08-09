/**
 * Resolves the bare specifier `@minecraft/server` to the simulator stub so the
 * pack's real scripts can be executed under plain Node, unmodified.
 */
export async function resolve(specifier, context, next) {
  if (specifier === "@minecraft/server") {
    return { url: new URL("./stub.mjs", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
