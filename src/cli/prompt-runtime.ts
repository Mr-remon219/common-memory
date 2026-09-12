import * as prompts from '@clack/prompts';
import { setImmediate } from 'node:timers/promises';

export * from '@clack/prompts';

// SQLite is loaded on the first actual database operation, which can occur between
// menus. Drain queued Node warnings before each prompt takes ownership of the cursor.
// Do not suppress warnings or change the process-wide warning handler.
export const select: typeof prompts.select = async options => { await setImmediate(); return prompts.select(options); };
export const multiselect: typeof prompts.multiselect = async options => { await setImmediate(); return prompts.multiselect(options); };
export const text: typeof prompts.text = async options => { await setImmediate(); return prompts.text(options); };
export const password: typeof prompts.password = async options => { await setImmediate(); return prompts.password(options); };
export const confirm: typeof prompts.confirm = async options => { await setImmediate(); return prompts.confirm(options); };
