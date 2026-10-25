/**
 * Source files import each other with ".js" specifiers, which is what TypeScript, esbuild and
 * Vercel's function builder all expect. Node's native type stripping runs ".ts" files but does
 * not map ".js" back to ".ts", so this hook does that for relative imports only.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    if (relative && specifier.endsWith('.js') && error?.code === 'ERR_MODULE_NOT_FOUND') {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
    throw error;
  }
}
