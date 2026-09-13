#!/usr/bin/env bun
/**
 * Command dispatch and terminal output. Everything here is presentation; the
 * pipeline modules hold the logic and are callable without it.
 */

import { basename, resolve } from "node:path";
// The version that scaffolded a workspace is the one known to work with it.
import { version } from "./package.json";
import { parseArgs } from "node:util";
import { initWorkspace } from "./init";
import {
  MARKER,
  backupsDir,
  findWorkspaceRoot,
  loadProjects,
  loadProjectsIfAny,
  projectByKey,
  requireWorkspace,
} from "./workspace";
import {
  databasePath,
  draftsFor,
  findingById,
  latestFindings,
  prepareDatabase,
  setTriage,
} from "./db";
import { backup, backups, restore } from "./db/backup";
import type { Finding } from "./db/schema";
import {
  DRAFT_KINDS,
  EVERGREEN,
  TRIAGE_STATUSES,
  defaultKindFor,
  type DraftKind,
  type OpportunityType,
  type TriageStatus,
} from "./vocabulary";
import { venueRuleFor, type ProjectProfile } from "./project";
import { generateDraft } from "./pipeline/draft";
import { rescore } from "./pipeline/rescore";
import { hostOf } from "./url";
import { scan } from "./pipeline/scan";

const HELP = `obserf — find free marketing opportunities for your projects

Usage: obserf <command> [options]

  scan      Discover, gate, enrich, and assess new opportunities
              --project <key>   Project to scan (default: all)
              --source <id>     Override profile sources (repeatable)
              --dry-run         List gate survivors; no model calls, no writes

  list      Show ranked opportunities
              --project <key>   Filter by project
              --status <s>      new | shortlisted | dismissed | acted (default: new)
              --min <score>     Minimum score (default: 1)
              --limit <n>       Default 20

  show <id>     Full detail for one finding, with its drafts
  draft <id>    Write a draft for a finding
                  --kind comment | reply | submission
                  (default: chosen from the opportunity type)
  triage <id> <status> [--note "..."]
  rescore       Recompute scores from stored components; no model calls
                  --project <key>   Restrict to one project
  projects      List the workspace's projects
  init [dir]    Create a workspace here, or in <dir>
  backup        Snapshot the database
  backups       List this database's snapshots
  restore [f]   Replace the database with a snapshot (newest by default)
                  f is a bare name from obserf backups, or ./a/path
  serve         Open the local review inbox
                  --port <n>    Default 4000

The model runs on your Claude Code subscription — no API key. GitHub borrows
the gh CLI's token (OBSERF_GITHUB_USER picks the account). Brave and Reddit read
BRAVE_API_KEY and REDDIT_CLIENT_ID/SECRET from .env; both are optional.`;

/** A numeric flag, rejected here rather than reaching SQL or `Bun.serve` as NaN. */
function intArg(name: string, raw: string | undefined, fallback: number, min = 1): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`--${name} must be an integer ${min} or greater, got "${raw}"`);
  }
  return value;
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function scoreColor(score: number): string {
  const code = score >= 70 ? 32 : score >= 40 ? 33 : 90;
  return `\x1b[${code}m${String(score).padStart(3)}\x1b[0m`;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log(HELP);
    return;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      project: { type: "string" },
      source: { type: "string", multiple: true },
      status: { type: "string" },
      kind: { type: "string" },
      note: { type: "string" },
      min: { type: "string" },
      limit: { type: "string" },
      port: { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });

  switch (command) {
    case "scan":
      return runScan(values);
    case "list":
      return runList(values);
    case "show":
      return runShow(positionals[0]);
    case "draft":
      return runDraft(positionals[0], values.kind);
    case "triage":
      return runTriage(positionals[0], positionals[1], values.note);
    case "rescore": {
      const count = rescore(values.project);
      console.log(`Rescored ${count} assessment${count === 1 ? "" : "s"}.`);
      return;
    }
    case "init":
      return runInit(positionals[0]);
    // These reach the database by path rather than by opening it, so without
    // this they would answer "no database at <cwd>/.obserf/obserf.db" from a
    // directory that is not a workspace, instead of saying that it is not one.
    case "backup": {
      requireWorkspace();
      const path = backup();
      console.log(path ? `Snapshot → ${path}` : `No database at ${databasePath}.`);
      return;
    }
    case "restore": {
      requireWorkspace();
      const { restored, replaced } = restore(positionals[0]);
      console.log(`Restored ${restored} → ${databasePath}`);
      if (replaced) console.log(dim(`The database it replaced is at ${replaced}`));
      return;
    }
    case "backups": {
      requireWorkspace();
      const found = backups();
      if (!found.length) {
        console.log(dim(`No snapshots of ${databasePath}.`));
        return;
      }
      // Bare names can be passed directly to `restore`.
      console.log(dim(`In ${backupsDir}, oldest first:`));
      for (const { path, takenAt, reason } of found) {
        // Display local time; the filename retains the UTC timestamp.
        const when = `${takenAt.toDateString().slice(4)} ${takenAt.toTimeString().slice(0, 5)}`;
        console.log(
          `  ${dim(when.padEnd(17))} ${(reason ?? "unlabelled").padEnd(11)} ${basename(path)}`,
        );
      }
      return;
    }
    case "projects": {
      for (const project of await loadProjects()) {
        console.log(`${bold(project.key.padEnd(10))} ${project.name}  ${dim(project.url)}`);
      }
      return;
    }
    case "serve": {
      const { serve } = await import("./web/server");
      await serve(intArg("port", values.port, 4000));
      return;
    }
    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`);
      process.exitCode = 1;
  }
}

async function runScan(values: { project?: string; source?: string[]; "dry-run"?: boolean }) {
  const projects = await loadProjects();
  const targets = values.project ? [projectByKey(projects, values.project)] : projects;
  const dryRun = values["dry-run"] ?? false;
  // A dry run writes nothing and needs no database, reading any existing one
  // read-only. Every other path here stores findings, so it opens — and upgrades
  // — before spending the first model call rather than after.
  if (!dryRun) prepareDatabase();

  for (const project of targets) {
    console.log(
      `\n${bold(project.name)} ${dim(`(${project.key})`)}${dryRun ? dim(" — dry run") : ""}`,
    );

    // Running totals for the progress line. A bare `44/76` for four minutes says
    // nothing about whether the scan is finding anything worth the wait.
    let scoring = 0;
    let best = 0;

    const result = await scan(project, {
      sourceIds: values.source,
      dryRun,
      onProgress: (event) => {
        switch (event.type) {
          case "source:start":
            process.stdout.write(dim(`  ${event.sourceId}… `));
            break;
          case "source:done":
            console.log(dim(`${event.count} candidates`));
            break;
          case "source:skip":
            console.log(dim(`  ${event.sourceId}… skipped (${event.reason})`));
            break;
          case "source:error":
            console.log(`\x1b[31mfailed: ${event.error}\x1b[0m`);
            break;
          case "enrich:start":
            // Not "repositories": which of its survivors an adapter actually
            // fetches for is its own business, and the pipeline only knows how
            // many it handed over.
            process.stdout.write(
              dim(`  ${event.sourceId}… extra evidence for ${event.count} candidates `),
            );
            break;
          case "enrich:done":
            console.log(dim("done"));
            break;
          case "assessed": {
            if (event.score > 0) {
              scoring++;
              best = Math.max(best, event.score);
            }
            // The suffix only ever grows, so the carriage return never leaves
            // characters from a longer previous line behind.
            const found = scoring ? dim(` · ${scoring} scoring · best ${best}`) : "";
            process.stdout.write(`\r  assessing ${event.done}/${event.total}${found}`);
            if (event.done === event.total) process.stdout.write("\n");
            break;
          }
        }
      },
    });

    const gates = Object.entries(result.rejected)
      .filter(([, n]) => n > 0)
      .map(([rule, n]) => `${n} ${rule}`)
      .join(", ");
    const outcome = dryRun
      ? `${result.survivors.length} would be assessed`
      : `${result.assessed} assessed`;
    console.log(
      dim(`  ${result.candidates} candidates → ${outcome}` + (gates ? ` (dropped: ${gates})` : "")),
    );
    // Repeat skips in the closing summary so a partial scan cannot be mistaken
    // for a complete one that found less.
    for (const { sourceId, reason } of result.skipped) {
      console.log(dim(`  ${sourceId} did not run: ${reason}`));
    }

    if (dryRun) {
      // Show every survivor so query tuning is not based on a truncated sample.
      for (const item of result.survivors) {
        console.log(`  ${dim(hostOf(item.url).padEnd(28))} ${item.title.slice(0, 68)}`);
      }
      continue;
    }

    const { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens } = result.usage;
    console.log(
      dim(
        `  ${inputTokens + cacheReadTokens + cacheWriteTokens} in ` +
          `(${cacheReadTokens} cached) / ${outputTokens} out tokens · ` +
          `~$${result.usage.estimatedCostUsd.toFixed(3)} at list price`,
      ),
    );

    for (const item of result.scored.slice(0, 10)) {
      console.log(
        `  ${scoreColor(item.score)} ${dim(`#${item.findingId}`)} ${item.title.slice(0, 80)}`,
      );
    }
    if (!result.scored.length) console.log(dim("  nothing scored above zero"));
  }
}

function runList(values: { project?: string; status?: string; min?: string; limit?: string }) {
  const status = (values.status?.split(",") ?? ["new"]) as TriageStatus[];
  for (const s of status) {
    if (!TRIAGE_STATUSES.includes(s)) {
      throw new Error(`Unknown status "${s}". Use: ${TRIAGE_STATUSES.join(", ")}`);
    }
  }

  const rows = latestFindings({
    project: values.project,
    status,
    minScore: intArg("min", values.min, 1, 0),
    limit: intArg("limit", values.limit, 20),
  });

  if (!rows.length) {
    console.log(dim("Nothing to show. Run `obserf scan` first."));
    return;
  }

  for (const { finding, assessment, note, drafts } of rows) {
    console.log(
      `${scoreColor(assessment?.score ?? 0)} ${dim(`#${String(finding.id).padEnd(4)}`)} ` +
        `${bold(finding.title.slice(0, 70))}`,
    );
    console.log(
      `     ${dim(`${finding.venue} · ${assessment?.opportunity ?? "?"}${drafts ? ` · ${drafts} draft${drafts === 1 ? "" : "s"}` : ""} · ${finding.url}`)}`,
    );
    if (assessment?.reason) console.log(`     ${dim(assessment.reason)}`);
    // Last and labelled: the model's reason and the operator's own conclusion
    // about it are different claims, and a shortlist is unreadable if they blur.
    if (note) console.log(`     ${dim("note:")} ${note}`);
  }
}

async function runShow(idArg: string | undefined) {
  const view = requireFinding(idArg);
  const { finding, assessment, status, note } = view;

  console.log(bold(finding.title));
  console.log(finding.url);
  console.log(
    dim(
      `${finding.venue} · ${finding.sourceId} · ${describeAge(finding.publishedAt, assessment?.opportunity ?? null)} · status: ${status}`,
    ),
  );
  // Show the operator the same evidence the model received, in the same terms.
  if (finding.metrics) {
    const { points, comments } = finding.metrics;
    const facts = [
      points !== undefined ? `${points} points` : "",
      comments !== undefined ? `${comments} comments` : "",
    ].filter(Boolean);
    if (facts.length) console.log(dim(facts.join(" · ")));
  }
  if (finding.repository) {
    const { stars, pullRequests } = finding.repository;
    const facts = [`${stars} stars`];
    if (pullRequests) {
      const resolved = pullRequests.merged + pullRequests.closedUnmerged;
      facts.push(
        `${pullRequests.open} open PRs`,
        `${pullRequests.merged} merged / ${pullRequests.closedUnmerged} closed unmerged ` +
          `in ${pullRequests.windowDays}d`,
      );
      // The proportion is what the operator is really reading, and working it
      // out by hand is the friction this exists to remove. Said as a merge rate,
      // not an acceptance rate: closing a pull request without merging it does
      // not establish that the maintainer refused it.
      if (resolved) {
        facts.push(
          `${Math.round((pullRequests.merged / resolved) * 100)}% merged of ${resolved} resolved`,
        );
      }
    }
    console.log(dim(facts.join(" · ")));
  }

  if (assessment) {
    console.log(
      `\n${bold(`Score ${assessment.score}`)}  ${dim(
        `relevance ${assessment.relevance} · intent ${assessment.intent} · welcome ${assessment.welcome} · reach ${assessment.reach}`,
      )}`,
    );
    console.log(`${assessment.opportunity ?? "?"} — ${assessment.reason}`);
    if (assessment.disqualified) console.log("\x1b[31mDisqualified by the model.\x1b[0m");
  }

  if (note) console.log(`\n${dim("Note:")} ${note}`);
  if (finding.excerpt) console.log(`\n${dim(finding.excerpt.slice(0, 800))}`);

  const drafts = draftsFor(finding.id);
  const profiles = drafts.length ? await loadProjectsIfAny() : [];

  for (const draft of drafts) {
    console.log(`\n${bold(`Draft (${draft.kind})`)} ${dim(draft.createdAt.toISOString())}`);
    console.log(draft.body);
  }

  // Under a stored draft as much as under a freshly written one, which is what
  // the inbox already does: this is the surface an operator re-reads a draft on
  // before posting it, and what obserf cannot establish about the venue has to
  // be said at that moment rather than only at the one that wrote it.
  //
  // Resolved before a line of draft is printed, so a profile that will not load
  // fails with the draft still unsaid rather than after `obserf show 42 | pbcopy`
  // has handed over the text without it. Loaded only when there is a draft to say
  // it about, because that is the whole reason `show` would import and execute
  // every profile module — and tolerantly, because reading a finding back must
  // survive the retirement of the profile that produced it, including the last
  // one in the workspace.
  if (drafts.length) {
    const project = profiles.find((p) => p.key === finding.project);
    console.log(`\n${venueReminder(finding, project)}`);
  }
}

async function runDraft(idArg: string | undefined, kindArg: string | undefined) {
  const view = requireFinding(idArg);
  // No opportunity type means the model named no moment to act on, and no draft
  // follows from that. `--kind` still works: drafting against a finding the
  // model rejected is the operator's call, made explicitly.
  const opportunity = view.assessment?.opportunity;
  const kind = (kindArg ??
    (opportunity
      ? defaultKindFor(opportunity, view.finding.isThreadComment)
      : null)) as DraftKind | null;
  if (kind === null) {
    throw new Error(
      `#${view.finding.id} has no opportunity type, so there is no default draft for it. ` +
        `Pass --kind ${DRAFT_KINDS.join(" | ")} to write one anyway.`,
    );
  }
  // Validated before the paid call: `$type<DraftKind>()` is a compile-time claim,
  // and SQLite would happily store a typo.
  if (!DRAFT_KINDS.includes(kind)) {
    throw new Error(`Unknown draft kind "${kindArg}". Use: ${DRAFT_KINDS.join(", ")}`);
  }
  const project = projectByKey(await loadProjects(), view.finding.project);

  const result = await generateDraft(project, view.finding, kind, view.assessment?.reason);
  console.log(`${bold(`Draft (${kind}) for #${view.finding.id}`)} ${dim(view.finding.url)}`);
  console.log(
    dim(
      result.contextVia
        ? `read the live thread (${result.contextVia})\n`
        : `could not read the live thread${result.contextWarning ? `: ${result.contextWarning}` : ""} — worked from the stored excerpt\n`,
    ),
  );
  console.log(result.body);
  console.log(`\n${venueReminder(view.finding, project)}`);
}

/**
 * What the operator established about this venue, and what obserf could not.
 * Printed wherever drafts are shown, because that is the moment it is acted on.
 * See docs/product/opportunities.md for why the claim is this weak.
 */
function venueReminder(finding: Finding, project: ProjectProfile | undefined): string {
  const venue = finding.venue;
  const rule = project && venueRuleFor(project, venue);
  // A missing profile makes guidance unreadable, not absent. Keep both missing
  // states undimmed so uncertainty is at least as visible as a recorded rule.
  const venueLine = !project
    ? `No profile for "${finding.project}" any more, so whatever it recorded about ${venue} ` +
      "is unreadable — restore it, or read the venue's rules and what a submission requires."
    : rule
      ? dim(
          `Your verified note for ${venue}: ${rule}\n` +
            "Confirm it still holds and that taking part costs nothing.",
        )
      : `No verified guidance recorded for ${venue}. Obserf cannot check whether a mention is ` +
        "permitted there or what taking part costs — read the venue's rules and what a " +
        "submission actually requires.";
  return `${venueLine}\n${dim("Then edit it and post it yourself. Obserf never posts.")}`;
}

function runTriage(idArg: string | undefined, statusArg: string | undefined, note?: string) {
  const view = requireFinding(idArg);
  const status = statusArg as TriageStatus;
  if (!TRIAGE_STATUSES.includes(status)) {
    throw new Error(`Unknown status "${statusArg}". Use: ${TRIAGE_STATUSES.join(", ")}`);
  }
  const previous = setTriage(view.finding.id, status, note);
  console.log(`#${view.finding.id} ${previous ?? "new"} → ${status}`);
}

/**
 * Current age for context, not the age used when the stored score was computed.
 * Rescoring refreshes decay without changing the assessment timestamp.
 * See docs/product/scoring.md; the inbox uses the same evergreen exemptions.
 */
function describeAge(publishedAt: Date | null, opportunity: OpportunityType | null): string {
  if (!publishedAt) return "date unknown, not decayed";
  const days = Math.max(0, Math.floor((Date.now() - publishedAt.getTime()) / 86_400_000));
  const exempt = opportunity && EVERGREEN.has(opportunity);
  return `${publishedAt.toDateString()} (${days}d ago${exempt ? ", evergreen" : ""})`;
}

/**
 * Reports the workspace it made and what to do next. A workspace is only useful
 * once `obserf` resolves inside it and the database exists, and neither of those
 * is something scaffolding files can do on its own.
 */
function runInit(dir?: string) {
  // A named directory is initialized as given. Bare `init` inside a workspace
  // updates that workspace rather than nesting a second one inside it, which is
  // what makes "safe to re-run" true from anywhere in the tree.
  const root = dir ? resolve(dir) : (findWorkspaceRoot(process.cwd()) ?? process.cwd());
  const written = initWorkspace(root);

  const created = written.includes(MARKER);
  console.log(
    bold(
      created
        ? `Workspace created in ${root}`
        : written.length
          ? `Workspace in ${root} updated`
          : `Workspace already in ${root}`,
    ),
  );
  for (const file of written) console.log(dim(`  + ${file}`));
  if (!written.length) return;

  // What to do next follows from what was written, not from whether this was the
  // first run: re-running `init` in a workspace that predates the scaffolded
  // `package.json` writes one, and that manifest needs installing whether or not
  // the marker is new.
  //
  // `init` never overwrites, so a directory that already had a `package.json`
  // has no `@obserf/cli` dependency in it — `bun install` there would install nothing
  // and leave every scaffolded import unresolvable.
  const steps = [
    `cd ${root}`,
    written.includes("package.json") ? `bun install` : `bun add @obserf/cli@^${version}`,
    ...(created ? [`$EDITOR projects/example.ts`, `bun run obserf scan --dry-run`] : []),
  ];
  console.log(`\nNext:`);
  for (const step of steps) console.log(dim(`  ${step}`));
  console.log(
    `\n${dim("Working from an obserf checkout instead? `bun link` there, then `bun link @obserf/cli` here.")}`,
  );
}

function requireFinding(idArg: string | undefined) {
  const id = Number(idArg);
  if (!Number.isInteger(id)) throw new Error("Expected a finding id, e.g. `obserf show 12`.");
  const view = findingById(id);
  if (!view) throw new Error(`No finding #${id}.`);
  return view;
}

main().catch((error: unknown) => {
  console.error(`\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m`);
  process.exitCode = 1;
});
