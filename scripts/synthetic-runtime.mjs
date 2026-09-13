// Developer-only shared scripted provider fixtures. Never imported by the installed runtime.
// The source loader supplies .js -> .ts resolution without copying a second protocol fixture.
await import('../tests/mcp/fixtures/source-loader.mjs');
export const { toolProvider, sendTools } = await import('../tests/helpers/tool-provider.ts');
export const { readTask } = await import('../tests/helpers/decision-runtime.ts');
