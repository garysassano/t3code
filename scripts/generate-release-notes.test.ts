import { assert, it } from "@effect/vitest";

import {
  countContributors,
  isReleaseNoteCommit,
  type PullRequest,
} from "./generate-release-notes.ts";

const pullRequest = (author: PullRequest["author"]): PullRequest => ({
  body: "",
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  author,
});

it("counts each person once and leaves out bots", () => {
  const commits = [
    { subject: "fix(web): one (#1)", authorName: "Ada Lovelace" },
    { subject: "fix(web): two (#2)", authorName: "Ada Lovelace" },
    { subject: "chore: bump (#3)", authorName: "dependabot[bot]" },
    { subject: "fix: direct push by a PR author", authorName: "Ada Lovelace" },
    { subject: "fix: direct push by someone else", authorName: "Grace Hopper" },
    { subject: "chore: direct push by a bot", authorName: "t3-code[bot]" },
    { subject: "fix(web): four (#4)", authorName: "Linus T" },
    { subject: "fix: direct push by a PR author with no profile name", authorName: "Linus T" },
  ];
  const pullRequests = new Map([
    [1, pullRequest({ __typename: "User", login: "ada", name: "Ada Lovelace" })],
    [2, pullRequest({ __typename: "User", login: "ada", name: "Ada Lovelace" })],
    [3, pullRequest({ __typename: "Bot", login: "dependabot" })],
    [4, pullRequest({ __typename: "User", login: "linus", name: null })],
  ]);

  assert.equal(countContributors(commits, pullRequests), 3);
});

it("leaves mobile-only scopes out and keeps shared ones", () => {
  const subjects = {
    "fix(mobile): a": false,
    "feat(android): b": false,
    "fix(ios)!: c": false,
    "fix(web,mobile): d": true,
    "feat(mobile,web): f": true,
    "fix(server): e": true,
  };
  for (const [subject, kept] of Object.entries(subjects)) {
    assert.equal(isReleaseNoteCommit({ subject, authorName: "" }), kept, subject);
  }
});
