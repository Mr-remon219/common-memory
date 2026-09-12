import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'node:sqlite' || specifier === 'sqlite') throw new Error('Read-only path loaded SQLite');
    return next(specifier, context);
  },
});
