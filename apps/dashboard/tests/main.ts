import assert from "assert";
import {
  buildAuditArgv,
  validateAuditLaunchRequest,
} from "../imports/api/audit-contract";
import {
  normalizeAuditRunResult,
  normalizeRunResult,
} from "../imports/api/run-contract";
import {
  presentAuditExecution,
} from "../imports/ui/pages/audit-presentation";

const TEST_AUDIT_REQUEST = {
  profile: "smoke",
  observerDriver: "changeStreams",
  meteorVersion: "3.5.1-beta.0",
  seed: null,
  tag: null,
} as const;

interface TestCursor {
  fetch(): unknown;
}

interface TestMeteorServer {
  method_handlers: Record<string, (this: unknown, ...args: unknown[]) => Promise<unknown>>;
  publish_handlers: Record<string, (this: unknown, ...args: unknown[]) => TestCursor>;
}

const TestMeteor = Meteor as typeof Meteor & { server: TestMeteorServer };

describe("dashboard", function () {
  it("package.json has correct name", async function () {
    const { name } = await import("../package.json");
    assert.strictEqual(name, "dashboard");
  });

  if (Meteor.isClient) {
    it("client is not server", function () {
      assert.strictEqual(Meteor.isServer, false);
    });

    it("presents active and terminal audit states without synthetic progress", function () {
      const running = presentAuditExecution({
        _id: "audit-1",
        status: "running",
        createdAt: new Date("2026-07-28T12:00:00Z"),
        startedAt: new Date("2026-07-28T12:00:10Z"),
        request: {
          profile: "smoke",
          observerDriver: "changeStreams",
          meteorVersion: "3.5.1-beta.0",
        },
      }, new Date("2026-07-28T12:01:15Z").getTime());
      assert.strictEqual(running.statusLabel, "Running");
      assert.strictEqual(running.elapsedLabel, "1m 5s");
      assert.strictEqual(running.canCancel, true);
      assert.strictEqual(running.auditStatusLabel, "not established");

      const failed = presentAuditExecution({
        ...running,
        status: "failed",
        finishedAt: new Date("2026-07-28T12:02:00Z"),
        auditStatus: "failed",
      });
      assert.strictEqual(failed.statusLabel, "Failed");
      assert.strictEqual(failed.canCancel, false);
      assert.strictEqual(failed.auditStatusLabel, "failed");
    });
  }

  if (Meteor.isServer) {
    it("server is not client", function () {
      assert.strictEqual(Meteor.isClient, false);
    });

    it("redacts repository paths, Mongo URLs, secrets, and control bytes", async function () {
      const { sanitizeAuditLogLine } = await import(
        "../server/audit-control-plane"
      );
      const line = sanitizeAuditLogLine(
        `${process.env.HOME}/workspace/run ~/workspace/run mongodb://user:pass@db/audit BENCH_API_KEY=secret\u0000`,
        `${process.env.HOME}/workspace`,
      );
      assert.strictEqual(
        line,
        "<repository>/run <repository>/run mongodb://<redacted> BENCH_API_KEY=<redacted>",
      );
    });

    it("reassembles streamed process lines without inventing output", async function () {
      const { createLineConsumer } = await import(
        "../server/audit-control-plane"
      );
      const lines: string[] = [];
      const consumer = createLineConsumer((line) => lines.push(line));
      consumer.push("Starting Met");
      consumer.push("eor\nWaiting");
      consumer.flush();
      assert.deepStrictEqual(lines, ["Starting Meteor", "Waiting"]);
    });

    it("rejects a symlinked audit result artifact", async function () {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const { readAuditResult } = await import(
        "../server/audit-control-plane"
      );
      const temporaryRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "dashboard-audit-result-"),
      );
      const outsidePath = path.join(
        os.tmpdir(),
        `dashboard-audit-outside-${Date.now()}.json`,
      );
      const linkedPath = path.join(temporaryRoot, "result.json");
      try {
        fs.writeFileSync(outsidePath, "{}\n");
        fs.symlinkSync(outsidePath, linkedPath);
        assert.throws(
          () => readAuditResult(linkedPath, {
            profile: "smoke",
            observerDriver: "changeStreams",
            expectedTag: "dashboard:test",
            meteorVersion: null,
          }, temporaryRoot),
          /did not produce a result artifact/,
        );
      } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
        fs.rmSync(outsidePath, { force: true });
      }
    });

    it("exposes bounded audit controls and publications without connection authorization", async function () {
      await import("../server/audit-control-plane");
      const handlers = TestMeteor.server.method_handlers;
      const publications = TestMeteor.server.publish_handlers;
      const recentPublication = publications["auditExecutions.recent"];
      const eventPublication = publications["auditEvents.forExecution"];
      const startHandler = handlers["auditExecutions.start"];
      assert.ok(recentPublication);
      assert.ok(eventPublication);
      assert.ok(startHandler);
      const executionCursor = recentPublication.call({}, 1);
      const eventCursor = eventPublication.call({}, "public-execution");

      assert.strictEqual(typeof executionCursor.fetch, "function");
      assert.strictEqual(typeof eventCursor.fetch, "function");
      assert.strictEqual(handlers["auditExecutions.authorize"], undefined);
      assert.strictEqual(handlers["auditExecutions.revoke"], undefined);
      await assert.rejects(
        startHandler.call({}, {
          profile: "unbounded",
          observerDriver: "changeStreams",
          meteorVersion: "3.5.1-beta.0",
          seed: "",
          tag: "",
        }),
        /Audit profile must be smoke or extreme/,
      );
    });

    it("enforces one durable active lease under concurrent inserts", async function () {
      const {
        auditControlPlaneReady,
      } = await import("../server/audit-control-plane");
      const {
        AuditExecutions,
      } = await import("../imports/api/audit-executions");
      await auditControlPlaneReady;
      const suffix = Date.now().toString(36);
      const ids = [`lease-a-${suffix}`, `lease-b-${suffix}`];
      try {
        const outcomes = await Promise.allSettled(ids.map((_id) => (
          AuditExecutions.insertAsync({
            _id,
            activeLease: "dashboard-audit",
            status: "queued",
            request: TEST_AUDIT_REQUEST,
            createdAt: new Date(),
          })
        )));
        assert.strictEqual(
          outcomes.filter((outcome) => outcome.status === "fulfilled").length,
          1,
        );
        assert.strictEqual(
          outcomes.filter((outcome) => outcome.status === "rejected").length,
          1,
        );
      } finally {
        await AuditExecutions.removeAsync({ _id: { $in: ids } });
      }
    });

    it("retains an interrupted lease until its process group is gone", async function () {
      const childProcess = await import("node:child_process");
      const {
        auditControlPlaneReady,
      } = await import("../server/audit-control-plane");
      const {
        AuditExecutions,
      } = await import("../imports/api/audit-executions");
      await auditControlPlaneReady;

      const handlers = TestMeteor.server.method_handlers;
      const resolveInterrupted = handlers["auditExecutions.resolveInterrupted"];
      assert.ok(resolveInterrupted);
      const context = {};
      const executionId = `recovery-${Date.now().toString(36)}`;
      const child = childProcess.spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { detached: true, stdio: "ignore" },
      );
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      assert.notStrictEqual(child.pid, undefined);
      if (child.pid === undefined) throw new Error("Test process did not receive a PID.");

      try {
        await AuditExecutions.insertAsync({
          _id: executionId,
          activeLease: "dashboard-audit",
          status: "interrupted",
          recoveryRequired: true,
          processId: child.pid,
          request: TEST_AUDIT_REQUEST,
          createdAt: new Date(),
        });
        await assert.rejects(
          resolveInterrupted.call(context, executionId),
          /process group is still running/,
        );
        const retained = await AuditExecutions.findOneAsync(executionId);
        assert.ok(retained);
        if (!retained) throw new Error("Interrupted execution was not retained.");
        assert.strictEqual(retained.activeLease, "dashboard-audit");
        assert.strictEqual(retained.processId, child.pid);

        process.kill(-child.pid, "SIGTERM");
        await new Promise((resolve) => child.once("close", resolve));
        assert.strictEqual(
          await resolveInterrupted.call(context, executionId),
          true,
        );
        const resolved = await AuditExecutions.findOneAsync(executionId);
        assert.ok(resolved);
        if (!resolved) throw new Error("Interrupted execution was not resolved.");
        assert.strictEqual(resolved.recoveryRequired, false);
        assert.strictEqual(resolved.activeLease, undefined);
        assert.strictEqual(resolved.processId, undefined);
      } finally {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The expected path already stopped the isolated test process group.
        }
        await AuditExecutions.removeAsync(executionId);
      }
    });
  }
});

describe("dashboard audit request contract", function () {
  it("normalizes the bounded request and builds shell-free argv", function () {
    const request = validateAuditLaunchRequest({
      profile: "extreme",
      observerDriver: "changeStreams",
      meteorVersion: "3.5.1-beta.0",
      seed: "42",
      tag: "research/run-1",
    });
    assert.deepStrictEqual(
      buildAuditArgv(request, {
        outputPath: "/private/results/audit.json",
        executionId: "audit-1",
      }),
      [
        "bench.js",
        "audit",
        "--profile",
        "extreme",
        "--observer-driver",
        "changeStreams",
        "--tag",
        "research/run-1",
        "--output",
        "/private/results/audit.json",
        "--seed",
        "42",
        "--meteor-version",
        "3.5.1-beta.0",
      ],
    );
  });

  it("rejects raw arguments, paths, environment, and shell fragments", function () {
    for (const value of [
      { profile: "smoke", args: ["--allow-remote-mongo"] },
      { profile: "smoke", env: { MONGO_URL: "mongodb://remote/audit" } },
      { profile: "smoke", outputPath: "/tmp/result.json" },
      { profile: "smoke", tag: "audit; rm -rf data" },
      { profile: "smoke", meteorVersion: "3.5.1 $(touch unsafe)" },
      { profile: "smoke", seed: "-1" },
      { profile: "smoke", seed: "4294967296" },
    ]) {
      assert.throws(() => validateAuditLaunchRequest(value));
    }
  });

  it("uses a correlation tag when the operator leaves the tag empty", function () {
    const request = validateAuditLaunchRequest({
      profile: "smoke",
      observerDriver: "oplog",
      meteorVersion: "",
      seed: "",
      tag: "",
    });
    const argv = buildAuditArgv(request, {
      outputPath: "/private/results/audit.json",
      executionId: "audit-2",
    });
    assert.deepStrictEqual(argv.slice(6, 8), ["--tag", "dashboard:audit-2"]);
    assert.strictEqual(argv.includes("--seed"), false);
    assert.strictEqual(argv.includes("--meteor-version"), false);
  });
});

describe("dashboard result contract", function () {
  const result = {
    timestamp: "2026-07-28T12:00:00.000Z",
    tag: "dashboard:audit-1",
    meteor: { version: "3.5.1-beta.0", sha: "release:3.5.1-beta.0" },
    runtime: {
      observer_driver_actual: "changeStreams",
      transport: "sockjs",
    },
    scenario: "change-stream-audit-smoke",
    app: "tasks-3.x",
    wall_clock_ms: 1_000,
    metrics: {
      change_stream_audit: {
        metric: "change_stream_audit",
        status: "passed",
        profile: "smoke",
        requested_driver: "changeStreams",
        actual_driver: "changeStreams",
      },
    },
  };

  it("normalizes the canonical timestamp without mutating the caller", function () {
    const normalized = normalizeRunResult(result);
    assert.ok(normalized.timestamp instanceof Date);
    assert.strictEqual(typeof result.timestamp, "string");
  });

  it("correlates audit scenario, tag, release, profile, and driver", function () {
    const normalized = normalizeAuditRunResult(result, {
      profile: "smoke",
      observerDriver: "changeStreams",
      expectedTag: "dashboard:audit-1",
      meteorVersion: "3.5.1-beta.0",
    });
    assert.strictEqual(
      normalized.metrics.change_stream_audit?.status,
      "passed",
    );
  });

  it("rejects a false pass when authoritative evidence is mismatched", function () {
    const mutated = structuredClone(result);
    mutated.metrics.change_stream_audit.profile = "extreme";
    assert.throws(
      () => normalizeAuditRunResult(mutated, {
        profile: "smoke",
        observerDriver: "changeStreams",
        expectedTag: "dashboard:audit-1",
        meteorVersion: "3.5.1-beta.0",
      }),
      /profile does not match/,
    );
  });

  it("rejects passed evidence when the actual observer differs", function () {
    const mutated = structuredClone(result);
    mutated.metrics.change_stream_audit.actual_driver = "oplog";
    assert.throws(
      () => normalizeAuditRunResult(mutated, {
        profile: "smoke",
        observerDriver: "changeStreams",
        expectedTag: "dashboard:audit-1",
        meteorVersion: "3.5.1-beta.0",
      }),
      /actual observer evidence does not match/,
    );
  });

  it("accepts valid failed evidence for import", function () {
    const failed = structuredClone(result);
    failed.metrics.change_stream_audit.status = "failed";
    const normalized = normalizeAuditRunResult(failed, {
      profile: "smoke",
      observerDriver: "changeStreams",
      expectedTag: "dashboard:audit-1",
      meteorVersion: "3.5.1-beta.0",
    });
    assert.strictEqual(
      normalized.metrics.change_stream_audit?.status,
      "failed",
    );
  });
});
