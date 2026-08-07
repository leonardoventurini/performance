import { Meteor } from 'meteor/meteor';

function assertEqual(actual: unknown, expected: unknown): void {
  if (!Object.is(actual, expected)) throw new Error(`expected ${String(expected)}, received ${String(actual)}`);
}

describe("task-3.x", function () {
  it("package.json has correct name", async function () {
    const { name } = await import("../package.json");
    assertEqual(name, 'task-3.x');
  });

  if (Meteor.isClient) {
    it("client is not server", function () {
      assertEqual(Meteor.isServer, false);
    });
  }

  if (Meteor.isServer) {
    it("server is not client", function () {
      assertEqual(Meteor.isClient, false);
    });
  }
});
