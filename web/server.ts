/**
 * The local review inbox. Bound to localhost and unauthenticated — the only
 * reader is the operator. See docs/adr/001-local-first-sqlite.md.
 */

import { loadProjectsIfAny } from "../workspace";
import { venueRuleFor } from "../project";
import { draftsFor, findingById, latestFindings, prepareDatabase, setTriage } from "../db";
import {
  DRAFT_KINDS,
  TRIAGE_STATUSES,
  defaultKindFor,
  type DraftKind,
  type TriageStatus,
} from "../vocabulary";
import { generateDraft } from "../pipeline/draft";
import index from "./index.html";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/**
 * Spellings of this machine that reach this server. `127.0.0.1` is what Bun
 * reports and what the log prints, but an operator who types `localhost` lands
 * on the same listener, and rejecting them would break every write with a
 * cross-origin error while the page itself loaded fine.
 *
 * A set of names rather than a comparison against the request's own `Host`: a
 * domain that resolves to loopback sends its own name in both headers, so
 * checking them against each other would accept it. Nobody can own these.
 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

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
  const projects = await loadProjectsIfAny();
  prepareDatabase();

  const server = Bun.serve({
    port,
    // Loopback only. Bun listens on every interface when hostname is omitted,
    // which would expose findings and model quota to the network.
    hostname: "127.0.0.1",
    development: { hmr: true, console: true },
    routes: {
      "/": index,

      "/api/projects": () => json(projects.map((p) => ({ key: p.key, name: p.name, url: p.url }))),

      "/api/findings": (req) => {
        const url = new URL(req.url);
        const status = url.searchParams.get("status");
        return json(
          latestFindings({
            project: url.searchParams.get("project") ?? undefined,
            status: status ? (status.split(",") as TriageStatus[]) : ["new"],
            minScore: Number(url.searchParams.get("min") ?? 1),
            limit: Number(url.searchParams.get("limit") ?? 100),
          }),
        );
      },

      "/api/findings/:id": (req) => {
        const view = findingById(Number(req.params.id));
        if (!view) return json({ error: "Not found" }, 404);
        // Use the startup profile for both the reminder and new drafts. Module
        // imports are cached, so edited rules require a server restart.
        // Guidance belongs on the finding response so stored drafts show it too;
        // it does not record which rule was used when a draft was written.
        const project = projects.find((p) => p.key === view.finding.project);
        return json({
          ...view,
          drafts: draftsFor(view.finding.id),
          // Distinguish missing profiles from missing rules; the inbox also
          // needs this to withhold drafting when the profile is gone.
          profileAvailable: project !== undefined,
          venueRule: project ? venueRuleFor(project, view.finding.venue) : null,
        });
      },

      "/api/findings/:id/triage": {
        POST: async (req) => {
          const blocked = crossOrigin(req, server);
          if (blocked) return blocked;

          const body = await jsonObject(req);
          if (body instanceof Response) return body;
          if (!TRIAGE_STATUSES.includes(body.status as TriageStatus)) {
            return json({ error: `Unknown status "${body.status}"` }, 400);
          }
          if (body.note !== undefined && typeof body.note !== "string") {
            return json({ error: "note must be a string" }, 400);
          }
          // An emptied note box means no note, not an empty one. Omitting `note`
          // entirely still leaves whatever is stored alone — see `setTriage`.
          const note = typeof body.note === "string" ? body.note.trim() || null : undefined;
          // The status this replaced, so the inbox can offer to undo a keystroke
          // it cannot otherwise take back. Read here rather than from the row the
          // browser was rendering, which a queued write may already have changed.
          const previous = setTriage(Number(req.params.id), body.status as TriageStatus, note);
          return json({ ok: true, previous: previous ?? null });
        },
      },

      "/api/findings/:id/draft": {
        POST: async (req) => {
          const blocked = crossOrigin(req, server);
          if (blocked) return blocked;

          const view = findingById(Number(req.params.id));
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
            // Surfaced in the UI rather than swallowed: a model failure and an
            // empty draft look identical otherwise.
            return json({ error: error instanceof Error ? error.message : String(error) }, 502);
          }
        },
      },
    },
  });

  console.log(`obserf review inbox → ${server.url}`);
  return server;
}
