# Rulebook

A rulebook says, for each page, which user types should be able to open it.

## Format

One column with the page, and one Yes/No column per user type:

| page | Site Admin | Channel Manager | Partner User |
|---|---|---|---|
| /#setup/roles | Yes | No | No |
| /#connections/contacts | Yes | Yes | Yes |

- **Page column:** named `page`, `page url`, `url`, `route`, `link` or `path`. Accepts `/#setup/roles`, `#setup/roles`, `setup/roles` or a full URL like `https://client.amp.vg/#setup/roles`.
- **User-type columns:** any names the client uses. They are shown to the tester exactly as written in the header.
- **Values:** `Yes` / `No` (also `Y`/`N`, `true`/`false`, `1`/`0`). Empty = not specified: reported, never guessed.
- Save as `.xlsx` (first sheet) or `.csv`. Start from [template.csv](template.csv).

## How the tool reads a sheet (no configuration needed)

1. **Header row:** the first of the top 10 rows that contains a page column. Title rows above it (e.g. "Internal User Personas") are skipped.
2. **Each column is classified:**

| Column | Treated as |
|---|---|
| `page` / `url` / `route` … | the page to test |
| `name` / `page name` / `title` / `main menu` / `sub menu` | page name shown in the report |
| `notes`, `comments`, `description`, `icon`, `info tip`, `module`, `type`, `parent` | ignored |
| any other column whose filled cells are Yes/No (at least one filled) | **user type** |
| any other column that is empty or holds other text (e.g. an "Owner" column with names) | ignored, with the reason shown |

3. **Typos:** a user-type column with a few odd values (e.g. `Yse`) is not silently dropped; the upload fails and names the exact row and column.
4. **Tester confirms:** the upload step lists the detected user types as tick boxes, plus how every other column was understood. Untick anything that isn't really a user type (e.g. a "Reviewed" Yes/No column).

Rows without a page (menu headings), `mailto:`/`javascript:` links, and duplicate pages are skipped.

## Files
- `template.csv`: starting point for a client rulebook.
- `itbd-demo.csv`: 3 ITBD intel pages.
- `internal-user-personas.csv`: transcribed from the *Internal User Personas* sheet (older format; still loads). Its routes follow the standard PRM menu. Clients with a custom menu need their own rulebook; the report lists the client's menu links that the rulebook doesn't cover.
