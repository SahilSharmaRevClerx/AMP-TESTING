import { existsSync, readFileSync } from 'node:fs';
import type { Environment } from './types';

/** The parts of run.config.json every CLI command needs, whatever the module. */
export interface SiteConfig {
  environment: Environment;
  delayMs?: number;
  outputDir: string;
}

/** Reads the site from a run config file (the Pages module reads its own extra settings itself). */
export function loadSiteConfig(file: string): SiteConfig {
  if (!existsSync(file)) {
    throw new Error(`Config not found: ${file}. Copy run.config.example.json to run.config.json and fill in the environment.`);
  }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<SiteConfig>;
  const env = raw.environment;
  if (!env?.baseUrl || env.baseUrl.includes('REPLACE-WITH')) throw new Error(`Set environment.baseUrl in ${file}`);
  let url: URL;
  try {
    url = new URL(env.baseUrl);
  } catch {
    throw new Error(`Base URL is not a valid URL: ${env.baseUrl}`);
  }
  return {
    environment: { ...env, name: env.name?.trim() || url.host, baseUrl: url.origin, isProduction: env.isProduction === true },
    delayMs: typeof raw.delayMs === 'number' ? raw.delayMs : undefined,
    outputDir: raw.outputDir || 'output',
  };
}
