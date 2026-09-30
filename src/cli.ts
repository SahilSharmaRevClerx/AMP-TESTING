import { commandCheck, commandMenu, commandRun, type CliOptions as RunOptions } from './run';
import { SafetyError } from './safety/gate';
import { scrub } from './util/mask';

const USAGE = `AMP permission testing

Usage:
  npm run check -- [options]     Validate each user type's token and show who it belongs to
  npm run menu  -- [options]     Show each user type's menu links vs the rulebook
  npm run run -- [options]       Full run: tokens → menus → calibration → page checks → report

Options:
  --config <file>     Run config (default: run.config.json)
  --only <a,b>        Only test these rulebook user types (calibration user always runs)
  --limit <n>         Only the first n pages of the rulebook (smoke test)
  --dry-run           Show the plan without making any request (run only)
  --headed            Show the browser window
`;

function parseArgs(argv: string[]): { command: string; opts: RunOptions } {
  const [command = 'help', ...rest] = argv;
  const opts: RunOptions = { configFile: 'run.config.json' };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = () => {
      const v = rest[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--config') opts.configFile = next();
    else if (a === '--only') opts.only = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--limit') opts.limit = Number(next());
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--headed') opts.headed = true;
    else throw new Error(`Unknown option ${a}`);
  }
  return { command, opts };
}

async function main(): Promise<number> {
  const { command, opts } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'check':
      return commandCheck(opts);
    case 'menu':
      return commandMenu(opts);
    case 'run':
      return commandRun(opts);
    default:
      console.log(USAGE);
      return command === 'help' ? 0 : 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    const err = e as Error;
    console.error(`\n${err instanceof SafetyError ? 'SAFETY STOP' : 'Error'}: ${scrub(err.message)}`);
    process.exit(1);
  });
