import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const forkCases = (
  [
    ["codex", "interrupted"],
    ["claudeAgent", "failed"],
  ] as const
).map(([driverName, status]) => {
  const driver = ProviderDriverKind.make(driverName);
  const instanceId = ProviderInstanceId.make(driver);
  const modelSelection = { instanceId, model: "test-model" };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () =>
      Effect.succeed(
        driver === "codex" ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
      ),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("Execution is paused after dispatch for handoff inspection"),
  };
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name: `fork-boundary-${driver}` },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { runEffectWorker: false },
  );

  return { driver, status, instanceId, modelSelection, layer };
});

it.effect("a persisted fork leaves PR watching with its parent until explicitly opted in", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const { instanceId, modelSelection } = forkCases[0]!;
    const sourceThreadId = ThreadId.make("fork-watch-source");
    const targetThreadId = ThreadId.make("fork-watch-target");
    const sourceRunId = RunId.make("fork-watch-source-run");
    const key = { host: "github.com", repository: "example/repo", number: 1 };
    const link = { url: "https://github.com/example/repo/pull/1", source: "agent" as const };

    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("fork-watch-create"),
      threadId: sourceThreadId,
      projectId: ProjectId.make("fork-watch-project"),
      title: "Watching source",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("fork-watch-source-run"),
          type: "run.created",
          threadId: sourceThreadId,
          runId: sourceRunId,
          occurredAt: now,
          payload: {
            id: sourceRunId,
            threadId: sourceThreadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("fork-watch-source-message"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make("fork-watch-parent-start"),
      threadId: sourceThreadId,
      ...key,
      watching: true,
      link,
    });
    const parentBefore = yield* orchestrator.getThreadShell(sourceThreadId);
    const parentWatch = parentBefore?.pullRequests?.[0]?.watch;
    assert.isDefined(parentWatch);
    assert.lengthOf(parentBefore?.pendingBackgroundTasks ?? [], 1);

    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("fork-watch-fork"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: { type: "run", runId: sourceRunId },
      createdBy: "user",
      creationSource: "mcp",
    });
    const fork = yield* orchestrator.getThreadShell(targetThreadId);
    assert.isNotNull(fork);
    assert.deepEqual(fork.pullRequests, [
      {
        ...key,
        ...link,
        linkedAt: parentWatch.startedAt,
        snapshot: null,
        stack: null,
      },
    ]);
    assert.deepEqual(fork.pendingBackgroundTasks, []);
    assert.deepEqual(yield* orchestrator.getThreadShell(sourceThreadId), parentBefore);

    const stale = yield* orchestrator
      .dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("fork-watch-stale-sync"),
        threadId: targetThreadId,
        ...key,
        startedAt: parentWatch.startedAt,
        watch: parentWatch,
        wake: {
          messageId: MessageId.make("fork-watch-unwanted-wake"),
          text: "A check failed",
          notification: {
            source: { kind: "monitor" },
            outcome: "updated",
            summary: "A check failed",
          },
        },
      })
      .pipe(Effect.flip);
    assert.equal(stale._tag, "OrchestratorDispatchError");
    assert.deepEqual((yield* orchestrator.getThreadProjection(targetThreadId)).runs, []);

    yield* TestClock.adjust("1 second");
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make("fork-watch-opt-in"),
      threadId: targetThreadId,
      ...key,
      watching: true,
      link,
    });
    const watchingFork = yield* orchestrator.getThreadShell(targetThreadId);
    assert.isDefined(watchingFork?.pullRequests?.[0]?.watch);
    assert.notEqual(watchingFork.pullRequests[0].watch.startedAt, parentWatch.startedAt);
    assert.lengthOf(watchingFork.pendingBackgroundTasks ?? [], 1);
    assert.deepEqual(yield* orchestrator.getThreadShell(sourceThreadId), parentBefore);

    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make("fork-watch-opt-out"),
      threadId: targetThreadId,
      ...key,
      watching: false,
    });
    const stoppedFork = yield* orchestrator.getThreadShell(targetThreadId);
    const [forkLink] = fork.pullRequests ?? [];
    assert.isDefined(forkLink);
    assert.deepEqual(stoppedFork?.pullRequests, [
      { ...forkLink, endedWatch: watchingFork.pullRequests[0].watch },
    ]);
    assert.deepEqual(stoppedFork?.pendingBackgroundTasks, []);
    assert.deepEqual(yield* orchestrator.getThreadShell(sourceThreadId), parentBefore);
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect.each(forkCases)(
  "bounds $driver context when continuing a fork of a $status run",
  ({ driver, status, instanceId, modelSelection, layer }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const sourceThreadId = ThreadId.make("fork-boundary-source");
      const targetThreadId = ThreadId.make("fork-boundary-target");
      const providerThreadId = ProviderThreadId.make("fork-boundary-native-thread");
      const sourceRunId = RunId.make("fork-boundary-source-run");
      const attemptId = RunAttemptId.make("interrupted-source-attempt");
      const providerTurnId = ProviderTurnId.make("interrupted-source-turn");
      const rootNodeId = NodeId.make("interrupted-source-root");

      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-source"),
        threadId: sourceThreadId,
        projectId: ProjectId.make("fork-boundary-project"),
        title: "Fork boundary source",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("source-provider-thread"),
            type: "provider-thread.updated",
            threadId: sourceThreadId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver,
              providerInstanceId: instanceId,
              providerSessionId: null,
              appThreadId: sourceThreadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-source", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 2,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });
      if (status === "interrupted") {
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("source-attempt"),
              type: "run-attempt.created",
              threadId: sourceThreadId,
              runId: sourceRunId,
              occurredAt: now,
              payload: {
                id: attemptId,
                runId: sourceRunId,
                attemptOrdinal: 1,
                rootNodeId,
                providerInstanceId: instanceId,
                providerThreadId,
                providerTurnId,
                reason: "initial",
                status,
                startedAt: now,
                completedAt: now,
              },
            },
            {
              id: EventId.make("source-provider-turn"),
              type: "provider-turn.updated",
              threadId: sourceThreadId,
              occurredAt: now,
              payload: {
                id: providerTurnId,
                providerThreadId,
                nodeId: rootNodeId,
                runAttemptId: attemptId,
                nativeTurnRef: { driver, nativeId: "turn:synthetic", strength: "weak" },
                ordinal: 1,
                status,
                startedAt: now,
                completedAt: now,
              },
            },
          ],
        });
      }
      for (const ordinal of [1, 2]) {
        const runId = ordinal === 1 ? sourceRunId : RunId.make("later-run");
        const messageId = MessageId.make(`source-message-${ordinal}`);
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`run-${ordinal}`),
              type: "run.created",
              threadId: sourceThreadId,
              runId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId: sourceThreadId,
                ordinal,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId,
                userMessageId: messageId,
                rootNodeId: null,
                activeAttemptId: ordinal === 1 && status === "interrupted" ? attemptId : null,
                status: ordinal === 1 ? status : "completed",
                queuePosition: null,
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
            {
              id: EventId.make(`item-${ordinal}`),
              type: "turn-item.updated",
              threadId: sourceThreadId,
              runId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`item-${ordinal}`),
                threadId: sourceThreadId,
                runId,
                nodeId: null,
                providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal,
                status: "completed",
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "user_message",
                createdBy: "user",
                creationSource: "web",
                inputIntent: "turn_start",
                messageId,
                text: ordinal === 1 ? "INCLUDED_SOURCE_MARKER" : "EXCLUDED_LATER_MARKER",
                attachments: [],
              },
            },
          ],
        });
      }
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-source"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "run", runId: sourceRunId },
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("continue-fork"),
        threadId: targetThreadId,
        messageId: MessageId.make("continue-fork"),
        text: "Continue from the selected source run",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const target = yield* orchestrator.getThreadProjection(targetThreadId);
      assert.equal(target.contextTransfers[0]?.resolution?.strategy, "portable_context");
      assert.lengthOf(target.contextHandoffs, 1);
      const handoff = target.contextHandoffs[0]!;
      const history = handoff.history?.messages.map((message) => message.text).join("\n") ?? "";
      assert.include(`${handoff.summaryText}\n${history}`, "INCLUDED_SOURCE_MARKER");
      assert.notInclude(`${handoff.summaryText}\n${history}`, "EXCLUDED_LATER_MARKER");
      assert.isNull(target.providerThreads[0]?.forkedFrom);
    }).pipe(Effect.provide(layer)),
);

it.effect.each([
  { execution: "portable_context", rejected: true },
  { execution: "native_fork", rejected: false },
] as const)(
  "a $execution fork's first /compact is rejected only when no history reaches it: $rejected",
  ({ execution, rejected }) => {
    const opened: Array<ProviderInstanceId> = [];
    const adapter = (driverName: "claudeAgent" | "codex") => {
      const driver = ProviderDriverKind.make(driverName);
      const instanceId = ProviderInstanceId.make(driverName);
      return {
        instanceId,
        driver,
        getCapabilities: () =>
          Effect.succeed(
            driver === "codex" ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
          ),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.sync(() => opened.push(instanceId)).pipe(
            Effect.andThen(
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver,
                providerSessionId: input.providerSessionId,
              }),
            ),
          ),
      } satisfies ProviderAdapter.ProviderAdapterV2["Service"];
    };
    const claude = adapter("claudeAgent");
    const target = execution === "portable_context" ? adapter("codex") : claude;
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const now = yield* DateTime.now;
      const sourceThreadId = ThreadId.make("fork-compact-source");
      const targetThreadId = ThreadId.make("fork-compact-target");
      const providerThreadId = ProviderThreadId.make("fork-compact-native-thread");
      const sourceRunId = RunId.make("fork-compact-source-run");
      const userMessageId = MessageId.make("fork-compact-source-message");
      const sourceSelection = { instanceId: claude.instanceId, model: "test-model" };

      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("fork-compact-create-source"),
        threadId: sourceThreadId,
        projectId: ProjectId.make("fork-compact-project"),
        title: "Fork compact source",
        modelSelection: sourceSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const item = {
        threadId: sourceThreadId,
        runId: sourceRunId,
        nodeId: null,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      } as const;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("fork-compact-provider-thread"),
            type: "provider-thread.updated",
            threadId: sourceThreadId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver: claude.driver,
              providerInstanceId: claude.instanceId,
              providerSessionId: null,
              appThreadId: sourceThreadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver: claude.driver,
                nativeId: "native-fork-compact-source",
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("fork-compact-source-run"),
            type: "run.created",
            threadId: sourceThreadId,
            runId: sourceRunId,
            occurredAt: now,
            payload: {
              id: sourceRunId,
              threadId: sourceThreadId,
              ordinal: 1,
              providerInstanceId: claude.instanceId,
              modelSelection: sourceSelection,
              providerThreadId,
              userMessageId,
              rootNodeId: null,
              activeAttemptId: null,
              status: "completed",
              queuePosition: null,
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
          // Each message alone exceeds the default 16k handoff budget, so a
          // portable handoff omits both whole items.
          {
            id: EventId.make("fork-compact-user-item"),
            type: "turn-item.updated",
            threadId: sourceThreadId,
            runId: sourceRunId,
            occurredAt: now,
            payload: {
              ...item,
              id: TurnItemId.make("fork-compact-user-item"),
              ordinal: 1,
              type: "user_message",
              createdBy: "user",
              creationSource: "web",
              inputIntent: "turn_start",
              messageId: userMessageId,
              text: "u".repeat(17_000),
              attachments: [],
            },
          },
          {
            id: EventId.make("fork-compact-assistant-item"),
            type: "turn-item.updated",
            threadId: sourceThreadId,
            runId: sourceRunId,
            occurredAt: now,
            payload: {
              ...item,
              id: TurnItemId.make("fork-compact-assistant-item"),
              ordinal: 2,
              type: "assistant_message",
              messageId: MessageId.make("fork-compact-assistant-message"),
              text: "a".repeat(17_000),
              streaming: false,
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-compact-fork"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "run", runId: sourceRunId },
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("fork-compact-compact"),
        threadId: targetThreadId,
        messageId: MessageId.make("fork-compact-compact"),
        text: "/compact",
        attachments: [],
        modelSelection: { instanceId: target.instanceId, model: "test-model" },
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();

      const projection = yield* orchestrator.getThreadProjection(targetThreadId);
      if (execution === "portable_context") {
        assert.equal(projection.contextTransfers[0]?.resolution?.strategy, "portable_context");
        assert.deepEqual(projection.contextHandoffs[0]?.history?.messages, []);
      } else {
        assert.isEmpty(projection.contextHandoffs);
      }
      const emptyCompaction = projection.turnItems.some(
        (turnItem) =>
          turnItem.type === "error" &&
          turnItem.failure.message === "Start a conversation before compacting this thread.",
      );
      assert.equal(emptyCompaction, rejected);
      assert.deepEqual(opened, rejected ? [] : [target.instanceId]);
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name: `fork-compact-${execution}` },
          ProviderAdapterRegistry.layerFromAdapters(
            target === claude ? [claude] : [claude, target],
          ),
        ),
      ),
    );
  },
);

const writeParentRun = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly ordinal: number;
  readonly status: "running" | "completed";
  readonly text: string;
}) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const { instanceId, modelSelection } = forkCases[0]!;
    const messageId = MessageId.make(`${input.runId}:message`);
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${input.runId}:created`),
          type: "run.created",
          threadId: input.threadId,
          runId: input.runId,
          occurredAt: now,
          payload: {
            id: input.runId,
            threadId: input.threadId,
            ordinal: input.ordinal,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: messageId,
            rootNodeId: null,
            activeAttemptId: null,
            status: input.status,
            queuePosition: null,
            requestedAt: now,
            startedAt: now,
            completedAt: input.status === "completed" ? now : null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
        {
          id: EventId.make(`${input.runId}:item`),
          type: "turn-item.updated",
          threadId: input.threadId,
          runId: input.runId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`${input.runId}:item`),
            threadId: input.threadId,
            runId: input.runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: input.ordinal * 100,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            createdBy: "user",
            creationSource: "web",
            inputIntent: "turn_start",
            messageId,
            text: input.text,
            attachments: [],
          },
        },
      ],
    });
  });

const createParent = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId: ProjectId.make("side-chat-project"),
      title: "Side chat parent",
      modelSelection: forkCases[0]!.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

it.effect("a side chat opened during the parent's first turn starts from a digest", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("side-chat-busy-parent");
    const sideChatId = ThreadId.make("side-chat-busy-child");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-busy-parent-run"),
      ordinal: 1,
      status: "running",
      text: "PARENT_RUNNING_MARKER",
    });
    const fork = (commandId: string, sourceThreadId: ThreadId, targetThreadId: ThreadId) =>
      orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make(commandId),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "latest_stable" },
        sideChat: true,
        createdBy: "user",
        creationSource: "web",
      });

    yield* fork("side-chat-busy-fork", parentId, sideChatId);
    const created = yield* orchestrator.getThreadProjection(sideChatId);
    assert.isTrue(created.thread.lineage.sideChat);
    assert.equal(created.thread.runtimeMode, "approval-required");
    assert.isNull(created.thread.forkedFrom);
    assert.deepEqual(created.contextTransfers[0]?.sourcePoint, { threadId: parentId });

    const nested = yield* fork(
      "side-chat-busy-nested",
      sideChatId,
      ThreadId.make("side-chat-busy-nested"),
    ).pipe(Effect.flip);
    assert.equal(nested._tag, "OrchestratorDispatchError");
    const busyMergeBack = yield* orchestrator
      .dispatch({
        type: "thread.merge_back",
        commandId: CommandId.make("side-chat-busy-merge-back"),
        sourceThreadId: sideChatId,
        targetThreadId: parentId,
        sourcePoint: { type: "latest_stable" },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.flip);
    assert.include(String(busyMergeBack.cause), "still running");

    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("side-chat-busy-first-message"),
      threadId: sideChatId,
      messageId: MessageId.make("side-chat-busy-first-message"),
      text: "What is the main thread doing?",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const started = yield* orchestrator.getThreadProjection(sideChatId);
    const [handoff] = started.contextHandoffs;
    assert.lengthOf(started.contextHandoffs, 1);
    assert.deepEqual(started.contextTransfers[0]?.resolution, {
      strategy: "portable_context",
      contextHandoffId: handoff!.id,
    });
    assert.include(handoff!.summaryText, "You are in a side chat beside the main thread.");
    assert.include(handoff!.summaryText, "- User: PARENT_RUNNING_MARKER");
    assert.include(handoff!.summaryText, `t3_thread_read on thread ${parentId}`);
    assert.equal(
      started.messages.find((message) => message.role === "user")?.text,
      "What is the main thread doing?",
    );

    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("side-chat-busy-delete-parent"),
      threadId: parentId,
    });
    assert.isNotNull((yield* orchestrator.getThreadProjection(sideChatId)).thread.deletedAt);
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("merge-back rejects a second fork's context until the first is consumed", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("merge-back-guard-parent");
    const parentRunId = RunId.make("merge-back-guard-parent-run");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: parentRunId,
      ordinal: 1,
      status: "completed",
      text: "Parent work",
    });
    const forkAndRun = (name: string) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(`merge-back-guard-${name}`);
        const runId = RunId.make(`merge-back-guard-${name}-run`);
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make(`merge-back-guard-fork-${name}`),
          sourceThreadId: parentId,
          targetThreadId: threadId,
          sourcePoint: { type: "run", runId: parentRunId },
          sideChat: true,
          createdBy: "user",
          creationSource: "web",
        });
        yield* writeParentRun({ threadId, runId, ordinal: 1, status: "completed", text: name });
        return { threadId, runId };
      });
    const mergeBack = (commandId: string, fork: { threadId: ThreadId; runId: RunId }) =>
      orchestrator.dispatch({
        type: "thread.merge_back",
        commandId: CommandId.make(commandId),
        sourceThreadId: fork.threadId,
        targetThreadId: parentId,
        sourcePoint: { type: "run", runId: fork.runId },
        createdBy: "user",
        creationSource: "web",
      });
    const first = yield* forkAndRun("first");
    const second = yield* forkAndRun("second");

    yield* mergeBack("merge-back-guard-first", first);
    const rejected = yield* mergeBack("merge-back-guard-second", second).pipe(Effect.flip);
    assert.include(String(rejected.cause), first.threadId);
    yield* mergeBack("merge-back-guard-first-again", first);

    const parent = yield* orchestrator.getThreadProjection(parentId);
    assert.deepEqual(
      parent.contextTransfers
        .filter((transfer) => transfer.type === "merge_back")
        .map((transfer) => [transfer.sourceThreadId, transfer.status]),
      [
        [first.threadId, "superseded"],
        [first.threadId, "pending"],
      ],
    );
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);
