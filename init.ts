/**
 * `obserf init`: the files a workspace needs, and nothing else.
 *
 * Scaffolding writes files. It does not install packages — the package manager
 * owns `node_modules`, and a workspace that Obserf linked by hand would depend
 * on wherever the copy that ran `init` happened to live, which under `bunx` is a
 * cache. It does not create the database either: the engine owns the schema and
 * the first command that needs state creates it. See `db/migrate.ts`.
 *
 * Split from `workspace.ts` because the two answer different questions — where
 * is the workspace and what is in it, versus how one comes to exist — and only
 * this half owns the scaffold text.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
// The version that scaffolded a workspace is the one known to work with it.
import { version } from "./package.json";
import { MARKER } from "./workspace";

/**
 * Creates a workspace, and never overwrites: run in a directory that already has
 * profiles, it fills in what is missing and leaves the rest alone. Returns the
 * files it wrote, so the caller can say what happened.
 *
 * The example profile is the format's documentation. It is written out rather
 * than linked because the first thing anyone does is copy it, and a profile that
 * is already valid is a better starting point than a description of one.
 */
export function initWorkspace(dir: string): string[] {
  const root = resolve(dir);
  const written: string[] = [];

  mkdirSync(join(root, "projects"), { recursive: true });

  const write = (relative: string, contents: string) => {
    const file = join(root, relative);
    if (existsSync(file)) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
    written.push(relative);
  };

  write(MARKER, SCAFFOLD.config);
  // Only into an empty workspace. Re-running `init` on one that already has
  // profiles should add what is missing, not hand back a sample the operator
  // deleted on purpose.
  if (!readdirSync(join(root, "projects"), { withFileTypes: true }).some((e) => e.isFile())) {
    write("projects/example.ts", SCAFFOLD.example);
  }
  write(".env.example", SCAFFOLD.env);
  ensureIgnored(root, written);
  write("package.json", SCAFFOLD.packageJson(version));
  write("tsconfig.json", SCAFFOLD.tsconfig);

  return written;
}

/**
 * Adds the rules that keep secrets and state out of a workspace's history,
 * without discarding an existing file: `obserf init` is meant to be safe to run
 * in a directory that already has one.
 */
function ensureIgnored(root: string, written: string[]): void {
  const file = join(root, ".gitignore");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const missing = IGNORED.filter(
    (rule) => !existing.split(/\r?\n/).some((line) => line.trim() === rule),
  );
  if (!missing.length) return;

  const prefix = !existing || existing.endsWith("\n") ? "" : "\n";
  writeFileSync(file, `${existing}${prefix}${SCAFFOLD.gitignore(missing)}`);
  written.push(existing ? ".gitignore (appended)" : ".gitignore");
}

/** Secrets, the state Obserf keeps, and what the package manager installs. */
const IGNORED = [".env", ".obserf/", "node_modules/"];

/**
 * Written once and then owned by the operator, so these say what a file is for
 * and leave the explaining to the documentation. A scaffold that carries prose
 * carries it forever: the copy in a workspace created today cannot be corrected
 * when the thing it describes changes.
 */
const SCAFFOLD = {
  config: `import { defineConfig } from "@obserf/cli";

// Marks this directory as an Obserf workspace: commands find it by walking up
// from wherever they run. Profiles live in ./projects and state in ./.obserf
// unless this says otherwise.
export default defineConfig({});
`,

  example: `import { defineProject } from "@obserf/cli";

/**
 * Copy this file, rename it, and make it true about your project.
 *
 * \`pitch\`, \`solves\` and \`notFor\` are read verbatim by the model, so write
 * them as a briefing rather than a form. \`notFor\` is the highest-leverage
 * field: it is what stops a confident, plausible, wrong recommendation.
 */
export default defineProject({
  key: "example",
  name: "Example",
  url: "https://example.com",

  pitch:
    "One paragraph, the way you would describe it to another engineer. What it does, and what it deliberately does not do.",

  solves: [
    "The problem in the words of someone who has it, not in your marketing words",
  ],

  notFor: [
    "The adjacent problem people will mistake this for",
    "The audience whose requirements this deliberately does not meet",
  ],

  queries: {
    // Shared by Hacker News and Reddit. Plain language, as someone with the
    // problem would type it.
    search: ["the problem, described the way someone having it would say it"],
    // Brave only, so web-index operators stay out of the other sources.
    brave: ["site:reddit.com the problem in someone else's words"],
    subreddits: ["subreddit-without-the-r-prefix"],
    // GitHub issue search syntax.
    github: ['"the problem" recommendation in:title is:issue state:open'],
    // GitHub *repository* search — how curated lists are found.
    githubRepos: ["awesome your-topic in:name,description"],
  },

  // Your own pages: a mention there is not an opportunity.
  blockedDomains: ["example.com"],

  voice:
    "Engineer to engineer. Say what it does and what it does not, name the tradeoff, and let someone decide for themselves.",
});
`,

  env: `# Copy to .env. Every value here is optional: Obserf calls the model through
# your Claude Code subscription, and a source without credentials is skipped
# with a reason rather than failing. See https://obserf.com for what each does.

# Brave web search — https://brave.com/search/api/
BRAVE_API_KEY=

# Reddit app-only OAuth, from a registered app with approved API access.
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=

# GitHub borrows the gh CLI's token. Name an account if you have several, or
# set GITHUB_TOKEN to bypass gh entirely.
# OBSERF_GITHUB_USER=
# GITHUB_TOKEN=

# Tunables
# OBSERF_MODEL=claude-opus-5
# OBSERF_MAX_AGE_DAYS=365
# OBSERF_REASSESS_AFTER_DAYS=7
# OBSERF_REASSESS_DISQUALIFIED_AFTER_DAYS=30
# OBSERF_RESULTS_PER_QUERY=10
# OBSERF_ASSESS_CONCURRENCY=4
`,

  gitignore: (rules: string[]) =>
    `# Secrets, the state Obserf keeps for this workspace, and installed packages.\n${rules.join("\n")}\n`,

  // Declaring the dependency rather than installing it: `bun install` is then
  // the next step from any workspace, and the file records which Obserf it was
  // scaffolded for. Working from a checkout, `bun link @obserf/cli` replaces it.
  packageJson: (version: string) => `{
  "name": "obserf-workspace",
  "private": true,
  "type": "module",
  "scripts": {
    "obserf": "obserf",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@obserf/cli": "^${version}"
  },
  "devDependencies": {
    "typescript": "^7"
  }
}
`,

  // The compiler is what validates a profile against \`ProjectProfile\`; Obserf
  // executes these files rather than compiling them, so without this the
  // contract in the package is one nothing in the workspace ever checks. Written
  // even into a directory that already has a \`package.json\`, where the
  // \`typecheck\` script above is not: the config is still what an editor and an
  // existing TypeScript setup read.
  tsconfig: `{
  "compilerOptions": {
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["obserf.config.ts", "projects/**/*.ts"]
}
`,
};
