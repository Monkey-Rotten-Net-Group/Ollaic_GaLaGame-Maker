import { readFile } from 'node:fs/promises';
import ts from '../node_modules/typescript/lib/typescript.js';

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      for (const extension of ['.ts', '.tsx']) {
        try {
          return await nextResolve(`${specifier}${extension}`, context);
        } catch {}
      }
    }
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  if (!/\.tsx?$/.test(url)) return nextLoad(url, context);
  const source = await readFile(new URL(url), 'utf8');
  const result = ts.transpileModule(source, {
    fileName: new URL(url).pathname,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  return { format: 'module', source: result.outputText, shortCircuit: true };
}
