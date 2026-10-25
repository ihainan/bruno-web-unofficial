/**
 * Stands in for upstream's playwright/index.ts in the generated run directory:
 * the upstream fixtures are used unchanged, only `playwright._electron` is
 * replaced so "launching the app" starts a Bruno Web server and a browser tab.
 */
import { test as upstreamTest } from './upstream-index';
import { createWebElectron } from './web-electron';

export * from './upstream-index';

export const test = upstreamTest.extend<{}, {}>({
  playwright: [
    async ({ playwright }, use) => {
      const web = createWebElectron(playwright);
      const patched = new Proxy(playwright, {
        get(target, prop, receiver) {
          return prop === '_electron' ? web : Reflect.get(target, prop, receiver);
        }
      });
      await use(patched);
      await web.dispose();
    },
    { scope: 'worker' }
  ] as any
});
