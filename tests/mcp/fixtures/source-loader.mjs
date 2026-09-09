// Exercise the real CLI before the verify gate's build step, without adding a runtime loader dependency.
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const sourceRoot = new URL('../../../src/', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(sourceRoot)) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(url)) return { url: url.href, shortCircuit: true };
    }
    if (specifier.endsWith('.js')) {
      try {const url = specifier.startsWith('file:') ? new URL(specifier) : new URL('file://' + specifier);if(url.href.startsWith(sourceRoot)){url.pathname=url.pathname.slice(0,-3)+'.ts';if(existsSync(url))return {url:url.href,shortCircuit:true};}}catch { /* ordinary package specifier */ }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
    return next(url, context);
  },
});
