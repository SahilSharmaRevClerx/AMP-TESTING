import { commandCheck, commandMenu, commandRun, type CliOptions as RunOptions } from './run';
import { commandMcp } from './mcp/run';
import { SafetyError } from './safety/gate';
import { scrub } from './util/mask';
import { setLogLevel } from './util/logger';

const USAGE = `AMP permission testing

Usage:
  npm run check -- [options]     Validate each user type's token and show who it belongs to
  npm run menu  -- [options]     Show each user type's menu links vs the rulebook
  npm run run -- [options]       Full run: tokens → menus → page checks → compare → report
  npm run mcp -- [options]       MCP connector health: workflows → servers → live tool lists → report (read-only)

Options:
  --config <file>     Run config (default: run.config.json)
  --only <a,b>        Only test these rulebook user types
  --limit <n>         Only the first n pages of the rulebook (smoke test)
  --dry-run           Show the plan without making any request (run only)
  --headed            Show the browser window
  --debug             Detailed developer logs (every page, request and blocked call)
  --account <k=f>     (mcp only, repeatable) account key + file holding its jwt; never a jwt value
  --delay-ms <n>      (mcp only) pause between AMP calls in ms (default 300)
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
    else if (a === '--account') opts.account = [...(opts.account ?? []), next()];
    else if (a === '--delay-ms') {
      const v = Number(next());
      if (!Number.isFinite(v)) throw new Error('--delay-ms needs a numeric value in ms');
      opts.delayMs = v;
    }
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--headed') opts.headed = true;
    else if (a === '--debug' || a === '--verbose') setLogLevel('debug');
    else throw new Error(`Unknown option ${a}`);
  }
  return { command, opts };
}

async function main(): Promise<number> {
  // The CLI prints its own readable progress; developer logs only show warnings unless asked for.
  if (!process.env.LOG_LEVEL) setLogLevel('warn');
  const { command, opts } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'check':
      return commandCheck(opts);
    case 'menu':
      return commandMenu(opts);
    case 'run':
      return commandRun(opts);
    case 'mcp':
      return commandMcp(opts);
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
