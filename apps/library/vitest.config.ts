import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

// SWC transform emits the TypeScript decorator metadata that NestJS's DI
// reflection relies on. Vitest's default esbuild transformer does not — which
// causes `@Injectable()`-decorated facades to resolve to `undefined` at runtime.
// We apply SWC to the whole workspace so unit and integration projects agree.
export default defineConfig({
  test: {
    globals: true,
  },
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
        },
        target: 'es2022',
      },
    }),
  ],
});
