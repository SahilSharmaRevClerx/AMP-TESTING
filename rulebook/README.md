# Rulebook

A rulebook says, for each page, which user types should be able to open it.

## Format

One column with the page, and one Yes/No column per user type. That's all:

| page | site_admin | super_admin | normal_user |
|---|---|---|---|
| /#setup/roles | Yes | Yes | No |
| /#connections/contacts | Yes | Yes | Yes |

- **Page column:** named `page`, `url`, `page url` or `route`. Accepts `/#setup/roles`, `#setup/roles`, `setup/roles` or a full URL like `https://client.amp.vg/#setup/roles`.
- **User-type columns:** every other column. Use any names the client has (`site_admin`, `super_admin`, `normal_user`, `channel_manager`…). In the tool, each column becomes a row where the tester pastes that user's tokens.
- **Values:** `Yes` / `No` (also `Y`/`N`). Empty = not specified: reported, never guessed.
- **Optional columns:** `name` (a readable page name) and `notes`, which are ignored for testing.
- Save as `.xlsx` (first sheet) or `.csv`. Start from [template.csv](template.csv).

If the rulebook has no `site_admin` column and the tester tests Site Admin anyway, Site Admin is expected to open every page.

## Files
- `template.csv`: starting point for a client rulebook.
- `internal-user-personas.csv`: transcribed from the *Internal User Personas* sheet (older format with menu headings; those rows are skipped). Its routes follow the standard PRM menu. Clients with a custom menu (e.g. ai.sb / Pinnacle) need their own rulebook. The report lists the client's menu links that the rulebook doesn't cover.
