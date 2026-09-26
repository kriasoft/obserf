/**
 * The local review inbox. Bound to localhost and unauthenticated — the only
 * reader is the operator. See docs/adr/001-local-first-sqlite.md.
 */

import { liveProfiles } from "../workspace";
import { venueRuleFor, type ProjectProfile } from "../project";
import {
  draftsFor,
  earlierAssessments,
  findingById,
  latestFindings,
  latestRunPerProject,
  prepareDatabase,
  recentRuns,
  setTriage,
  DecisionChanged,
  storedProjects,
} from "../db";
import {
  DISMISSAL_CATEGORIES,
  DRAFT_KINDS,
  TRIAGE_STATUSES,
  defaultKindFor,
  type DismissalCategory,
  type DraftKind,
  type TriageStatus,
} from "../vocabulary";
import { DraftRefused, generateDraft } from "../pipeline/draft";
import { explain, rank } from "../pipeline/score";
import index from "./index.html";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/**
 * Names of this machine that reach this server, which binds IPv4 only:
 * `127.0.0.1`, which the log prints, and `localhost`, which an operator may
 * type. A fixed set rather than a comparison with the request's own `Host`,
 * since a rebound domain sends its own name in both headers.
 */
const LOOPBACK = new Set(["127.0.0.1", "localhost"]);

/**
 * Whether the request names this machine in `Host`: the DNS-rebinding defense
 * (.github/SECURITY.md). A rebound page's `Host` still names the attacker's domain,
 * and its GET reads carry no `Origin`, so `crossOrigin` alone cannot protect
 * them. The whole authority is matched, so `localhost:junk` and
 * `localhost@elsewhere` are refused rather than read as their prefix.
 */
export function addressedToThisMachine(req: Request): boolean {
  const match = /^(127\.0\.0\.1|localhost)(?::(\d{1,5}))?$/i.exec(req.headers.get("Host") ?? "");
  return match !== null && Number(match[2] ?? 0) <= 65535;
}

/**
 * A route behind that check, in one place rather than inside each handler.
 * Every `/api` route must go through it, reads as much as writes: reading the
 * inbox is the first half of the attack. Nothing enforces that but review.
 *
 * The page stays unwrapped: Bun serves it from the route table rather than a
 * handler, and obserf's own HTML and bundle carry nothing the attack is after.
 */
function local<R extends Request>(
  handler: (req: R) => Response | Promise<Response>,
): (req: R) => Response | Promise<Response> {
  return (req) =>
    addressedToThisMachine(req)
      ? handler(req)
      : json({ error: "This server answers only to localhost." }, 403);
}

function sameMachine(origin: string, server: URL): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === server.protocol && LOOPBACK.has(url.hostname) && url.port === server.port
    );
  } catch {
    return false; // `Origin: null`, from a sandboxed frame, and anything unparseable.
  }
}

/**
 * The request body, or the 400 to return instead. Parsing succeeds for `null`,
 * `[]` and `5` as readily as for an object, and every caller here goes straight
 * on to read a property — which throws, and Bun answers that with a 500 page.
 */
async function jsonObject(req: Request): Promise<Record<string, unknown> | Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return json({ error: "Body is not JSON" }, 400);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return json({ error: "Body must be a JSON object" }, 400);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Decimal digits as a safe integer, or null. Checked by spelling before `Number`,
 * which reads `""` as 0 and accepts `1e3` and `0x10`; safe because past 2^53 the
 * parsed value is no longer the digits typed.
 */
function wholeNumber(raw: string): number | null {
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * The finding id in the path, or the 400 to answer instead. `Number("abc")` is
 * NaN, and NaN used to reach a foreign key and come back as Bun's development
 * error page, with the working directory and source lines.
 */
export function findingIdIn(params: { id: string }): number | Response {
  const id = wholeNumber(params.id);
  if (id === null || id < 1) {
    return json({ error: `"${params.id}" is not a finding id` }, 400);
  }
  return id;
}

/**
 * A query parameter that has to be a whole number, or the 400 to answer instead.
 * `?min=abc` used to come back as an empty list, which reads as "nothing scored
 * that high" rather than "that is not a number".
 */
export function intParam(url: URL, name: string, fallback: number, min: number): number | Response {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = wholeNumber(raw);
  if (value === null || value < min) {
    return json({ error: `${name} must be a whole number, ${min} or greater` }, 400);
  }
  return value;
}

/**
 * A 400 for a query key this route does not read, or one given twice — or null.
 * `get` takes the first of a repeated key and ignores an unknown one, so
 * `?projec=x` would be answered as if no filter had been asked for: the CLI's
 * `ACCEPTS` check, at the other front end.
 */
export function unexpectedParams(url: URL, allowed: readonly string[]): Response | null {
  for (const key of new Set(url.searchParams.keys())) {
    if (!allowed.includes(key)) return json({ error: `Unknown parameter "${key}"` }, 400);
    if (url.searchParams.getAll(key).length > 1) {
      return json({ error: `Parameter "${key}" was given more than once` }, 400);
    }
  }
  return null;
}

/**
 * The project a `?project=` parameter names, or the 400 to answer instead.
 *
 * Absent is no filter. Empty is refused: `latestFindings` and `recentRuns` test
 * the key for truthiness, so `?project=` would widen the answer to every
 * project. Unknown is refused as a mistyped `--project` is, since a filter
 * matching nothing reads as a quiet week. Known means a profile's key or one the
 * database holds rows for, as in the CLI, so a retired profile stays readable.
 */
export function projectParam(
  url: URL,
  projects: Pick<ProjectProfile, "key">[],
): string | undefined | Response {
  const raw = url.searchParams.get("project");
  if (raw === null) return undefined;
  // Before the lookups, so a stray empty key in the database cannot pass it.
  if (raw === "") return json({ error: 'Unknown project ""' }, 400);
  if (projects.some((p) => p.key === raw)) return raw;
  // Second, so a maintenance read need not fall through to the database for a
  // key the workspace already answers.
  if (storedProjects().includes(raw)) return raw;
  return json({ error: `Unknown project "${raw}"` }, 400);
}

/**
 * Mutation routes consume model quota and change triage state, and the server
 * has no authentication because its only reader is the operator. Binding to
 * loopback stops other machines reaching it; it does not stop a page in the
 * operator's own browser posting here. Rejecting a foreign `Origin` and requiring
 * JSON blocks cross-origin browser writes. Requests without `Origin` remain
 * allowed for local CLI clients; this is not client authentication.
 */
function crossOrigin(req: Request, server: { url: URL }): Response | null {
  const origin = req.headers.get("Origin");
  if (origin && !sameMachine(origin, server.url)) {
    return json({ error: "Cross-origin request" }, 403);
  }
  if (!req.headers.get("Content-Type")?.startsWith("application/json")) {
    return json({ error: "Expected Content-Type: application/json" }, 415);
  }
  return null;
}

export async function serve(port = 4000) {
  // Both before the port opens: a workspace whose profiles do not load, or a
  // database that cannot be opened and upgraded, is a startup failure rather
  // than a 500 on whichever request happens to need them first. Having none is
  // not that failure — the inbox is where stored findings are read, and the last
  // profile being retired must not close the record it produced.
  const profiles = await liveProfiles();
  prepareDatabase();

  const server = Bun.serve({
    port,
    // Loopback only. Bun listens on every interface when hostname is omitted,
    // which would expose findings and model quota to the network.
    hostname: "127.0.0.1",
    /**
     * Measured on Bun 1.4.2: in development mode Bun refuses a foreign `Host` on
     * the page, its assets and the HMR socket, and never on handler routes —
     * which is why `local` wraps every API route itself. That page check is
     * defense in depth, since the page carries no data; CI notices if it goes.
     */
    development: { hmr: true, console: true },
    /**
     * Without this, an unhandled error is answered with Bun's development error
     * page: working directory, absolute paths, source lines. Logged in full
     * where the operator is; answered with a fixed sentence, since an arbitrary
     * message can carry SQL or a path just as well.
     */
    error(cause) {
      console.error(cause);
      return json({ error: "Internal server error; see the terminal for details." }, 500);
    },
    routes: {
      "/": index,

      // `profileError` with the list, so the inbox can say on every screen —
      // not only inside an open finding — that it is working from the last
      // profiles that loaded rather than the ones on disk.
      "/api/projects": local(async () => {
        const { projects, profileError } = await profiles();
        return json({
          projects: projects.map((p) => ({ key: p.key, name: p.name, url: p.url })),
          profileError,
        });
      }),

      /**
       * The latest scan: of the project when filtered, and of each project that
       * has one when not, since the newest run across a mixed list establishes
       * nothing about the rest. A project with no run is absent; the inbox, which
       * knows which projects it shows, says so.
       */
      "/api/runs/latest": local(async (req) => {
        const url = new URL(req.url);
        const shape = unexpectedParams(url, ["project"]);
        if (shape) return shape;
        const project = projectParam(url, (await profiles()).projects);
        if (project instanceof Response) return project;
        return json(project ? recentRuns({ project, limit: 1 }) : latestRunPerProject());
      }),

      /**
       * Every parameter checked, as the CLI checks them. The inbox's controls
       * send only valid values; a hand-typed or bookmarked URL used to get a
       * 200 with an empty list, indistinguishable from a quiet week.
       */
      "/api/findings": local(async (req) => {
        const url = new URL(req.url);
        const shape = unexpectedParams(url, ["status", "project", "min", "limit"]);
        if (shape) return shape;

        const status = url.searchParams.get("status")?.split(",") ?? ["new"];
        const unknown = status.find((s) => !TRIAGE_STATUSES.includes(s as TriageStatus));
        if (unknown !== undefined) return json({ error: `Unknown status "${unknown}"` }, 400);

        const project = projectParam(url, (await profiles()).projects);
        if (project instanceof Response) return project;

        const minScore = intParam(url, "min", 1, 0);
        if (minScore instanceof Response) return minScore;
        const limit = intParam(url, "limit", 100, 1);
        if (limit instanceof Response) return limit;

        return json(
          rank(latestFindings({ project, status: status as TriageStatus[] }), { minScore, limit }),
        );
      }),

      /**
       * How many findings each status holds, split at the list's default minimum
       * score: `scoring` is what a tab lists with zeros hidden, `zero` what the
       * zeros toggle would add. Scored like the list, since the split applies to
       * the score now, and uncapped, where the list stops at its limit.
       */
      "/api/counts": local(async (req) => {
        const url = new URL(req.url);
        const shape = unexpectedParams(url, ["project"]);
        if (shape) return shape;
        const project = projectParam(url, (await profiles()).projects);
        if (project instanceof Response) return project;

        const counts = Object.fromEntries(
          TRIAGE_STATUSES.map((s) => [s, { scoring: 0, zero: 0 }]),
        ) as Record<TriageStatus, { scoring: number; zero: number }>;
        for (const row of rank(latestFindings({ project }))) {
          counts[row.status][row.score > 0 ? "scoring" : "zero"]++;
        }
        return json(counts);
      }),

      "/api/findings/:id": local(async (req) => {
        const id = findingIdIn(req.params);
        if (id instanceof Response) return id;
        const view = findingById(id);
        if (!view) return json({ error: "Not found" }, 404);
        // The profile as it is on disk now, or the last version that loaded.
        // Guidance belongs on the finding response so stored drafts show it too;
        // it does not record which rule was used when a draft was written.
        const { projects, profileError } = await profiles();
        const project = projects.find((p) => p.key === view.finding.project);
        // One computation for the number and its working, so they cannot disagree.
        const breakdown = view.assessment
          ? explain(view.assessment, view.finding.publishedAt)
          : null;
        return json({
          ...view,
          score: breakdown?.score ?? 0,
          breakdown,
          // Bounded by the current verdict's id, as `obserf show` is, so one a
          // scan writes after this read is never filed as earlier.
          earlier: view.assessment ? earlierAssessments(view.finding.id, view.assessment.id) : [],
          drafts: draftsFor(view.finding.id),
          // Distinguish missing profiles from missing rules; the inbox also
          // needs this to withhold drafting when the profile is gone.
          profileAvailable: project !== undefined,
          venueRule: project ? venueRuleFor(project, view.finding.venue) : null,
          // Why drafting is off while the profiles fail to reload.
          profileError,
        });
      }),

      "/api/findings/:id/triage": {
        POST: local(async (req) => {
          const blocked = crossOrigin(req, server);
          if (blocked) return blocked;

          const id = findingIdIn(req.params);
          if (id instanceof Response) return id;
          // Checked rather than left to the foreign key, which answered a
          // missing finding with a 500 and a page of source.
          if (!findingById(id)) return json({ error: "Not found" }, 404);

          const body = await jsonObject(req);
          if (body instanceof Response) return body;
          if (!TRIAGE_STATUSES.includes(body.status as TriageStatus)) {
            return json({ error: `Unknown status "${body.status}"` }, 400);
          }
          if (body.note !== undefined && typeof body.note !== "string") {
            return json({ error: "note must be a string" }, 400);
          }
          // Omitted leaves a dismissal's category alone, `null` clears it — the
          // three states `setTriage` gives the note.
          const category = body.category;
          if (
            category !== undefined &&
            category !== null &&
            !DISMISSAL_CATEGORIES.includes(category as DismissalCategory)
          ) {
            return json({ error: `Unknown category "${String(category)}"` }, 400);
          }
          if (category && body.status !== "dismissed") {
            return json({ error: "A category describes a dismissal" }, 400);
          }
          if (body.hidden !== undefined && typeof body.hidden !== "boolean") {
            return json({ error: "hidden must be a boolean" }, 400);
          }
          if (body.amend !== undefined && typeof body.amend !== "boolean") {
            return json({ error: "amend must be a boolean" }, 400);
          }
          if (
            body.appendNote !== undefined &&
            (typeof body.appendNote !== "string" || !body.appendNote.trim())
          ) {
            return json({ error: "appendNote must be a non-empty string" }, 400);
          }
          if (body.appendNote !== undefined && body.note !== undefined) {
            return json({ error: "Send note or appendNote, not both" }, 400);
          }
          // An emptied note box means no note, not an empty one. Omitting `note`
          // entirely still leaves whatever is stored alone — see `setTriage`.
          const note = typeof body.note === "string" ? body.note.trim() || null : undefined;
          // The decision this replaced, so the inbox can offer to undo a keystroke
          // it cannot otherwise take back. Read here rather than from the row the
          // browser was rendering, which a queued write may already have changed.
          let previous;
          try {
            previous = setTriage(id, {
              status: body.status as TriageStatus,
              note,
              appendNote: typeof body.appendNote === "string" ? body.appendNote.trim() : undefined,
              category: category as DismissalCategory | null | undefined,
              hidden: body.hidden,
              amend: body.amend,
            });
          } catch (error) {
            if (error instanceof DecisionChanged) return json({ error: error.message }, 409);
            throw error;
          }
          return json({
            ok: true,
            previous: previous?.status ?? null,
            previousCategory: previous?.category ?? null,
          });
        }),
      },

      "/api/findings/:id/draft": {
        POST: local(async (req) => {
          const blocked = crossOrigin(req, server);
          if (blocked) return blocked;

          const id = findingIdIn(req.params);
          if (id instanceof Response) return id;
          const view = findingById(id);
          if (!view) return json({ error: "Not found" }, 404);

          // Not silently read as "no kind given": that would pick a default and
          // spend model quota answering a request nobody managed to make.
          const body = await jsonObject(req);
          if (body instanceof Response) return body;
          const opportunity = view.assessment?.opportunity;
          // As in the CLI: without an opportunity type there is no draft that
          // follows, so the client has to say what it wants instead.
          // Resolved in one expression so the absent case cannot be tested for
          // differently than it is handled: a literal `{"kind": null}` is a
          // request with no kind, and a finding the model named no opportunity
          // for has no kind to fall back to.
          const kind =
            body.kind ??
            (opportunity ? defaultKindFor(opportunity, view.finding.isThreadComment) : null);
          if (kind == null) {
            return json({ error: "This finding has no opportunity type; pass a kind." }, 400);
          }
          // `$type<DraftKind>()` is a compile-time claim, not a database
          // constraint — an unvalidated kind would reach a model call and be stored.
          if (!DRAFT_KINDS.includes(kind as DraftKind)) {
            return json({ error: `Unknown draft kind "${String(kind)}"` }, 400);
          }

          // A missing profile is a workspace conflict (409); reserve 502 for
          // failures during draft generation.
          const { projects, profileError } = await profiles();
          if (profileError) {
            return json({ error: `The profiles on disk do not load: ${profileError}` }, 409);
          }
          const project = projects.find((p) => p.key === view.finding.project);
          if (!project) {
            return json(
              { error: `No profile for "${view.finding.project}". Restore it to draft again.` },
              409,
            );
          }

          try {
            const result = await generateDraft(
              project,
              view.finding,
              kind as DraftKind,
              view.assessment?.reason,
            );
            return json(result);
          } catch (error) {
            // Nothing failed: the fetch established a fact that rules the draft out.
            if (error instanceof DraftRefused) return json({ error: error.message }, 409);
            // Surfaced in the UI rather than swallowed: a model failure and an
            // empty draft look identical otherwise.
            return json({ error: error instanceof Error ? error.message : String(error) }, 502);
          }
        }),
      },
    },
  });

  console.log(`obserf review inbox → ${server.url}`);
  return server;
}
