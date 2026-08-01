# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"CUP SYSTEM" (repo/DB still named JAM/JAM 2026 internally) — a dance-competition platform with two halves that share one Supabase project:

1. **Registration** — a public multi-step inscription wizard (`index.html`) plus supporting pages (`check.html`, `musica.html`) where competitors register, pay, and upload their music before the event.
2. **Live event operation** — `evento.html` (lineup/accreditation/DJ/projection) and `competencia.html` (judges scoring + director control), used on-site during the competition by staff on tablets/laptops, all synced in real time.

`admin.html` is the shared back-office: manages registrations (the old "JAM" scope) and now also logs in through the same role-based auth as the event pages.

Static HTML + inline `<script>` per page, no framework, no build step, deployed on Vercel with Supabase (Postgres + Storage + Realtime) as the only backend, Resend for email.

## Commands

- `vercel dev` — run the site + `/api/*.js` functions locally.
- `vercel --prod` / `git push` to `main` — deploy (Vercel auto-deploys `main` via GitHub integration).
- No test suite, linter, or build step. `npm run build` is a no-op placeholder.
- To sanity-check a hand-edit to one of the giant inline `<script>` blocks without opening a browser: extract the script bodies and run them through Node's `vm.Script` (compiles, doesn't execute) to catch syntax errors — there's no linter wired in otherwise.

## Environment variables (server-side, `api/*.js`)

- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` — service-role access used by every `api/*.js` function (they all talk to PostgREST directly via `fetch`, not the JS SDK — same Node/WebSocket-compatibility reason as before).
- `RESEND_API_KEY` — transactional email.
- `SITE_URL` — base URL for links embedded in emails.

Client-side pages hardcode the Supabase project URL and **anon** key (`SB_URL`/`SB_ANON`) — expected, relies on RLS, not a leak to fix.

## Data model (Supabase, 3 custom schemas + `public`)

- `public.inscripciones` — one row per registration (unchanged from the original registration-only system): `instancia` (`reg`/`rep`/`nac`/`int`), payment/upload URLs, `categorias` JSON, etc.
- `personal.usuarios` — login for **all** roled users (director, jurado 1-10, staff, lineup, acreditacion, dj, presentador, proyeccion). Password is bcrypt, checked server-side via the `personal.verificar_login(user, pass)` RPC — `admin.html`, `evento.html`, and `competencia.html` all authenticate through this same RPC now (admin's old hardcoded client-side password is gone).
- `evento.lineup` — the on-site queue: one row per participant with `estado` (`pendiente → presente → pista → listo`, or `ausente`), denormalizes `codigo_id`/`nombre_grupo` from `inscripciones` for speed.
- `evento.musica`, `evento.config`, and (seen live in the DB but not in the checked-in schema file) `evento.categoria_activa`, `evento.cronograma_categorias` — event-day config and running state.
- `scoring.sesiones` — one row per **performance currently or previously being judged** (one participant can have several across categories). Only one row has `activa = true` at a time system-wide; that's what drives every judge's screen.
- `scoring.puntajes` — one row per judge per session, `items` JSONB + `subtotal`, `cerrado` flag.
- `scoring.descalificaciones` — unanimous-vote DQ tracking.

`codigo_id` (e.g. `JAM-NAC-0200`) is the join key stitching `inscripciones` ↔ `evento.lineup` ↔ `scoring.sesiones` together — **it is not a foreign key**, just a shared text value. `fix-codigo-id-atomico.sql` documents a real production incident where three different code paths each computed `codigo_id` their own unsafe way (in-memory counters, no locking) and produced duplicate codes that cross-contaminated two different participants' scoring state. If you're generating a new `codigo_id` anywhere, use `evento.lineup_insertar_auto(...)` (atomic, sequence-based) — don't reintroduce a `COUNT(*)+1` or `MAX(...)+1` scheme.

## Realtime sync pattern (evento.html / competencia.html)

Every live view (judge scoring, director panel, lineup, DJ queue, projection) uses the **same three-layer pattern** to stay in sync without manual refresh — when touching any of these screens, keep all three layers:

1. A Supabase Realtime channel (`.channel(...).on("postgres_changes", ...)`) subscribed to the relevant table(s).
2. A `setInterval` polling fallback (a few seconds) as a safety net for when Realtime silently drops — comments in the code call this out explicitly as "red de seguridad."
3. A `visibilitychange` listener that forces an immediate resync when a tablet's tab comes back to the foreground.

Layer 3 was missing for jurados until it was added to fix a real bug: iPad Safari kills the WebSocket and throttles timers when the screen locks or the tab backgrounds, and the `.subscribe()` status callback only retried on `CHANNEL_ERROR`/`TIMED_OUT` — not `CLOSED`, which is what iOS actually reports. If you add a new realtime screen, subscribe to `CLOSED` too and wire a `visibilitychange` resync, or it'll silently go stale on tablets exactly like this one did.

Realtime publication membership (`ALTER PUBLICATION supabase_realtime ADD TABLE ...`) has to be set on the live Supabase project itself, not just declared in `schema-scoring-evento.sql` — check `pg_publication_tables` if a new live table isn't updating in real time.

## Registration side (mostly unchanged from the original JAM system)

- `INST` (`reg`/`rep`/`nac`/`int`) still drives wizard steps, pricing, categories, and payment account throughout `index.html`, duplicated across `index.html`/`admin.html`/`check.html`/`musica.html`/`api/notify.js` — grep all of them when changing pricing or payment details, they're not shared code.
- Music upload during registration is a bolted-on module near the bottom of `index.html`'s script (a single hidden `<input accept="audio/*">` reused for every category slot, wired via `MutationObserver` since `#mslots` gets rebuilt on every render). Its file-type check used to hard-reject anything whose `file.type` didn't start with `audio/` AND whose extension wasn't in a fixed whitelist — iOS reports empty/generic MIME types for files picked via Files/WhatsApp share sheets, so real music routinely got rejected. Fixed to only reject files with a MIME type that's positively a *non*-audio type (image/video/text/pdf); don't reintroduce a strict audio allowlist.
- `musica.html` is the **separate**, post-registration music upload page (linked via a `musica_token` per category) — it already only warns on an unrecognized type rather than blocking.

## Known duplication to check when editing

Category lists, pricing, `INSTANCIA_CFG`-style config, and payment account details are copy-pasted across `index.html`, `admin.html`, `check.html`, `musica.html`, and `api/notify.js` — there's no shared module. `codigo_id` formatting logic is similarly duplicated between `api/notify.js`, `admin.html`, and now `evento.lineup_insertar_auto` in Postgres. When changing any of these, grep across all of them rather than editing one.
