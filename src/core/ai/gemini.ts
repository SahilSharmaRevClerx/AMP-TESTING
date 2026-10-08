import { ApiError, GoogleGenAI } from '@google/genai';

/**
 * Google Gemini access shared by the modules that offer an AI review (Permission Setter, MCP).
 * The key comes from GEMINI_API_KEY (or GOOGLE_API_KEY) and is never sent to a page.
 */

/** Gemini model for AI reviews; override with GEMINI_MODEL. */
export const DEFAULT_AI_MODEL = 'gemini-2.5-pro';
export function aiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_AI_MODEL;
}

/** Whether a Gemini key is set for this process (the key itself is never sent to the page). */
export function aiKeySet(): boolean {
  return !!(process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim());
}

export function newAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
  if (!apiKey) throw new Error('no Gemini API key: set GEMINI_API_KEY and restart the server');
  const baseUrl = process.env.GEMINI_BASE_URL?.trim();
  return new GoogleGenAI({ apiKey, ...(baseUrl ? { httpOptions: { baseUrl } } : {}) });
}

/** Readable reason for an AI review failure (missing or wrong key, unknown model, rate limit, …). */
export function aiErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 400 && /api key/i.test(e.message)) return 'the Gemini API key was refused: check GEMINI_API_KEY and restart the server';
    if (e.status === 401 || e.status === 403) return 'the Gemini API key was refused: check GEMINI_API_KEY and restart the server';
    if (e.status === 404) return `Gemini model "${aiModel()}" not found: set GEMINI_MODEL to a model your key can use and restart`;
    if (e.status === 429) return 'Gemini rate limit or quota reached; try the AI review again later';
    return `Gemini API error ${e.status}: ${e.message}`;
  }
  return (e as Error).message;
}
