/** Command-line options, parsed once in src/cli.ts and passed to each module's command. */
export interface CliOptions {
  configFile: string;
  only?: string[];
  limit?: number;
  dryRun?: boolean;
  headed?: boolean;
  /** MCP only: repeatable KEY=jwt-file. */
  account?: string[];
  /** MCP only: pause between AMP calls in ms. */
  delayMs?: number;
  /** MCP only: also read the workflows and check their connector steps. */
  workflows?: boolean;
}
