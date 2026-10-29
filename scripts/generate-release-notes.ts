#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

// Release notes cover web, desktop, and server. Mobile ships its own store notes.
const MOBILE_ONLY_SCOPE = /^[a-z]+\((?:mobile|android|ios)[^)]*\)!?:/i;
const PULL_REQUEST_NUMBER = /\(#(\d+)\)$/;
const PULL_REQUEST_BODY_LIMIT = 300;
const SUMMARY_MODEL = "gpt-6.1-terra";

const SUMMARY_INSTRUCTIONS = `You write release notes for T3 Code, a GUI for coding agents (web and desktop apps backed by a server; providers like Codex, Claude, Cursor, OpenCode).

These notes cover the web app, desktop app, and server only. The mobile app has its own release notes, so leave out anything only about mobile, iOS, or Android.

You get the commit subjects merged since the last release, oldest first. Most end with a PR number like (#1234). Each commit shows lines added and removed and files changed, then a trimmed PR description on the next line starting with ">". Use the descriptions to understand what changed for users and why it matters. Line counts hint at size, but a small change can still matter most.

Output Markdown in exactly this shape and nothing else:

## Highlights
2 to 4 short sentences. Name only the new features a user would care about most. Each feature gets a few words that make the benefit clear, not a description of how it works or where the button is.

## Fixes
- 5 to 10 bullets, one fix each, under 10 words, ending with the PR number like (#123).
- Each bullet names what was broken and says it works now. A user who hit the bug should recognize it.
- Only list fixes from fix commits. New abilities go in Highlights or nowhere. Say "again" only if the commit says it.

How to write:
- Pick only significant, user-facing changes. Leave out visual polish (focus rings, spacing, colors), layout tweaks, refactors, tests, CI, build, docs, deps, internal tooling, and performance or efficiency work a user would not feel.
- Include Labs and beta features, with "(beta)" after the feature. Leave out work marked internal testing or dev-only.
- Describe each feature as it is at the end of the range. If a beta feature became standard later in the range, it is not beta.
- Say what the user gets, as short as possible. Cut details, conditions, and mechanics.
- No defaults or rollout state ("on by default", "now available", "behind a flag").
- For lists of file types or formats, use common extensions: "previews for .docx, .ttf, .sqlite, .zip and more".
- No internal names, env vars, file paths, or code terms.
- No em dashes. No hype words. Do not invent anything that is not in the input.

Examples of the tone:
- Bad: "Cmd+K now finds the right thread first, and it searches message text too." Good: "Much better Cmd+K search."
- Bad: "You can share a thread with a guest who watches it live and sends messages that you approve." Good: "Share threads with guests, safely."
- Bad: "Triage issues from the command palette." Good: "Fix and debug T3 Code itself with a new 'triage' command."
- Bad: "Settings and Usage open as large modals over your thread." Good: leave it out.
- Bad: "Cmd/Ctrl+W closes tabs safely (#25860)" Good: "Cmd/Ctrl+W no longer closes the whole window (#25860)"`;

export class EmptyReleaseRangeError extends Schema.TaggedError<EmptyReleaseRangeError>()(
  "EmptyReleaseRangeError",
  { range: Schema.String },
) {}

export interface ReleaseCommit {
  readonly subject: string;
  readonly authorName: string;
}

const PullRequest = Schema.Struct({
  body: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  changedFiles: Schema.Number,
  author: Schema.NullOr(
    Schema.Struct({
      __typename: Schema.String,
      login: Schema.String,
      name: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
export type PullRequest = typeof PullRequest.Type;

const PullRequestQueryResponse = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Record(Schema.String, Schema.NullOr(PullRequest)),
  }),
});

const GeneratedNotes = Schema.Struct({ body: Schema.String });

const SummaryResponse = Schema.Struct({
  output: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      content: Schema.optional(
        Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
      ),
    }),
  ),
  usage: Schema.optional(
    Schema.Struct({ input_tokens: Schema.Number, output_tokens: Schema.Number }),
  ),
});

export const pullRequestNumber = (subject: string) => {
  const match = PULL_REQUEST_NUMBER.exec(subject);
  return match ? Number(match[1]) : undefined;
};

export const isReleaseNoteCommit = (commit: ReleaseCommit) =>
  !MOBILE_ONLY_SCOPE.test(commit.subject);

/** Keeps the prose of a PR body: no images, tables, headings, HTML, or verification sections. */
export function trimPullRequestBody(body: string, limit = PULL_REQUEST_BODY_LIMIT): string {
  const [prose = ""] = body.split(/\n#+\s*(?:Verification|Council|Test|Testing|Screenshots)\b/i);
  const text = prose
    .split("\n")
    .filter((line) => line.trim() !== "" && !/^\s*[!|#<]/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

export function buildSummaryInput(
  commits: ReadonlyArray<ReleaseCommit>,
  pullRequests: ReadonlyMap<number, PullRequest>,
): string {
  return commits
    .flatMap(({ subject }) => {
      const number = pullRequestNumber(subject);
      const pullRequest = number === undefined ? undefined : pullRequests.get(number);
      if (!pullRequest) return [subject];
      const line = `${subject} [+${pullRequest.additions} -${pullRequest.deletions}, ${pullRequest.changedFiles} files]`;
      const body = trimPullRequestBody(pullRequest.body);
      return body ? [line, `  > ${body}`] : [line];
    })
    .join("\n");
}

/** PR authors without bots, plus authors of direct pushes who have no PR in the range. */
export function countContributors(
  commits: ReadonlyArray<ReleaseCommit>,
  pullRequests: ReadonlyMap<number, PullRequest>,
): number {
  const people = new Set<string>();
  const names = new Set<string>();
  for (const { author } of pullRequests.values()) {
    if (!author || author.__typename === "Bot" || author.login.endsWith("[bot]")) continue;
    people.add(author.login);
    if (author.name) names.add(author.name);
  }
  for (const commit of commits) {
    if (pullRequestNumber(commit.subject) === undefined && !names.has(commit.authorName)) {
      people.add(commit.authorName);
    }
  }
  return people.size;
}

export function formatElapsed(milliseconds: number): string {
  const units = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ] as const;
  for (const [unit, size] of units) {
    const count = Math.floor(milliseconds / size);
    if (count >= 1) return `${count} ${unit}${count === 1 ? "" : "s"}`;
  }
  return "under a minute";
}

export function buildReleaseHeader(options: {
  readonly version: string;
  /** Epoch milliseconds. */
  readonly builtAt: number;
  readonly previousBuiltAt: number;
  readonly changes: number;
  readonly contributors: number;
}): string {
  const date = DateTime.formatUtc(DateTime.makeUnsafe(options.builtAt), {
    locale: "en-US",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const elapsed = formatElapsed(options.builtAt - options.previousBuiltAt);
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  return `**v${options.version.replace(/^v/, "")}** · ${date} · ${plural(options.changes, "change")} from ${plural(options.contributors, "contributor")} in ${elapsed}`;
}

/** The summary leads; GitHub's full list folds under it. Clients cut the body at `<details>`. */
export function assembleReleaseNotes(
  header: string,
  summary: Option.Option<string>,
  fullChangelog: string,
): string {
  if (Option.isNone(summary)) return `${header}\n\n${fullChangelog.trim()}\n`;
  return `${header}\n\n${summary.value.trim()}\n\n<details>\n<summary>Full changelog</summary>\n\n${fullChangelog.trim()}\n\n</details>\n`;
}

const run = Effect.fn("generateReleaseNotes.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.string(ChildProcess.make(command, args));
});

const decodeJson = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema));

const readCommits = Effect.fn("generateReleaseNotes.readCommits")(function* (
  previousTag: string,
  ref: string,
) {
  const log = yield* run("git", [
    "log",
    "--reverse",
    "--format=%s%x1f%an",
    `${previousTag}..${ref}`,
  ]);
  return log
    .split("\n")
    .filter((line) => line !== "")
    .map((line): ReleaseCommit => {
      const [subject = "", authorName = ""] = line.split("\x1f");
      return { subject, authorName };
    })
    .filter(isReleaseNoteCommit);
});

const readCommitDate = Effect.fn("generateReleaseNotes.readCommitDate")(function* (ref: string) {
  return Date.parse((yield* run("git", ["log", "-1", "--format=%cI", ref])).trim());
});

const readPullRequests = Effect.fn("generateReleaseNotes.readPullRequests")(function* (
  repository: string,
  numbers: ReadonlyArray<number>,
) {
  const [owner, name] = repository.split("/");
  const pullRequests = new Map<number, PullRequest>();
  for (let start = 0; start < numbers.length; start += 100) {
    const fields = numbers
      .slice(start, start + 100)
      .map(
        (number) =>
          `pr${number}: pullRequest(number: ${number}) { body additions deletions changedFiles author { __typename login ... on User { name } } }`,
      )
      .join("\n");
    const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
    const response = yield* decodeJson(PullRequestQueryResponse)(
      yield* run("gh", [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
      ]),
    );
    for (const [alias, pullRequest] of Object.entries(response.data.repository)) {
      if (pullRequest) pullRequests.set(Number(alias.slice(2)), pullRequest);
    }
  }
  return pullRequests;
});

const readFullChangelog = Effect.fn("generateReleaseNotes.readFullChangelog")(function* (options: {
  readonly repository: string;
  readonly tag: string;
  readonly ref: string;
  readonly previousTag: string;
}) {
  const response = yield* run("gh", [
    "api",
    `repos/${options.repository}/releases/generate-notes`,
    "-f",
    `tag_name=${options.tag}`,
    "-f",
    `target_commitish=${options.ref}`,
    "-f",
    `previous_tag_name=${options.previousTag}`,
  ]);
  return (yield* decodeJson(GeneratedNotes)(response)).body;
});

const summarize = Effect.fn("generateReleaseNotes.summarize")(function* (input: string) {
  const apiKey = yield* Config.Redacted("OPENAI_API_KEY");
  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* HttpClientRequest.post("https://api.openai.com/v1/responses").pipe(
    HttpClientRequest.bearerToken(apiKey),
    HttpClientRequest.bodyJson({
      model: SUMMARY_MODEL,
      reasoning: { effort: "low" },
      instructions: SUMMARY_INSTRUCTIONS,
      input: `Commits:\n${input}`,
    }),
    Effect.flatMap(httpClient.execute),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(SummaryResponse)),
    Effect.timeout("3 minutes"),
  );
  yield* Effect.logInfo("release summary generated").pipe(
    Effect.annotateLogs({
      model: SUMMARY_MODEL,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    }),
  );
  const text = response.output
    .flatMap((item) => item.content ?? [])
    .flatMap((part) => (part.type === "output_text" && part.text ? [part.text] : []))
    .join("")
    .trim();
  return text === "" ? Option.none<string>() : Option.some(text);
});

const command = Command.make(
  "generate-release-notes",
  {
    repository: Flag.String("repository").pipe(Flag.withDescription("GitHub owner/name.")),
    tag: Flag.String("tag").pipe(Flag.withDescription("Tag being released.")),
    ref: Flag.String("ref").pipe(Flag.withDescription("Commit being released.")),
    previousTag: Flag.String("previous-tag").pipe(Flag.withDescription("Previous release tag.")),
    version: Flag.String("version").pipe(Flag.withDescription("Version shown in the header.")),
    output: Flag.String("output").pipe(Flag.withDescription("File to write the notes to.")),
  },
  ({ repository, tag, ref, previousTag, version, output }) =>
    Effect.gen(function* () {
      const commits = yield* readCommits(previousTag, ref);
      // An empty log usually means the previous tag is missing from a shallow clone.
      if (commits.length === 0) {
        return yield* new EmptyReleaseRangeError({ range: `${previousTag}..${ref}` });
      }
      const numbers = [
        ...new Set(commits.flatMap(({ subject }) => pullRequestNumber(subject) ?? [])),
      ];
      const [pullRequests, fullChangelog, builtAt, previousBuiltAt] = yield* Effect.all(
        [
          readPullRequests(repository, numbers),
          readFullChangelog({ repository, tag, ref, previousTag }),
          readCommitDate(ref),
          readCommitDate(previousTag),
        ],
        { concurrency: "unbounded" },
      );
      const header = buildReleaseHeader({
        version,
        builtAt,
        previousBuiltAt,
        changes: commits.length,
        contributors: countContributors(commits, pullRequests),
      });
      // A failed summary still publishes the header and GitHub's full list.
      const summary = yield* summarize(buildSummaryInput(commits, pullRequests)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("release summary failed, publishing the full list only", cause).pipe(
            Effect.as(Option.none<string>()),
          ),
        ),
      );
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(output, assembleReleaseNotes(header, summary, fullChangelog));
      yield* Effect.logInfo("release notes written").pipe(
        Effect.annotateLogs({
          output,
          commits: commits.length,
          summarized: Option.isSome(summary),
        }),
      );
    }),
).pipe(
  Command.withDescription("Write release notes with a model summary over GitHub's full list."),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Logger.layer([Logger.consolePretty()]),
        NodeServices.layer,
        FetchHttpClient.layer,
      ),
    ),
    NodeRuntime.runMain,
  );
}
