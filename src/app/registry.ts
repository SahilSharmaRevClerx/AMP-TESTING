import type { TestModule } from '../core/module';
import { DEBUG_DIR, OUTPUT_DIR } from '../core/paths';
import { sharedRoutes } from '../core/routes';
import { createPagesModule } from '../modules/pages';
import { createUserCheck } from '../modules/pages/user-check';
import { createSetterModule } from '../modules/setter';
import { createMcpModule } from '../modules/mcp';

/**
 * Every testing module the server runs. To add one: create src/modules/<name>/index.ts exporting
 * a TestModule (routes, page, catalog card), then add it here. Modules never import each other;
 * when one needs another's work, it is passed in here (e.g. the setter's "check as the users"
 * step is done by the Pages module).
 */
export const MODULES: TestModule[] = [
  sharedRoutes,
  createSetterModule({ checkAsUsers: createUserCheck({ outputDir: OUTPUT_DIR, debugDir: DEBUG_DIR }) }),
  createPagesModule(),
  createMcpModule(),
];
