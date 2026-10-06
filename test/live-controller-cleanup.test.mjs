import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import * as safety from "./live-safety.mjs";

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("live cleanup keeps controller identity on the launch wrapper", () => {
  assert.equal(typeof safety.controllerRecords, "function");
  const identity={ProcessId:41,Started:"2026-10-04T00:00:00.000Z",Name:"node.exe",CommandLine:"node runner.mjs"};
  const rawChild={pid:41,identity:{ProcessId:999}};
  const wrapper={child:rawChild,label:"first",identity};
  assert.deepEqual(safety.controllerRecords([wrapper]), [{label:"first controller",identity}]);
  for(const name of ["live-guardian.mjs","live-recovery.mjs"]) {
    const source=fs.readFileSync(path.join(repo, "test", name), "utf8");
    assert.match(source, /children\.push\(run\)/, name+" must register launch wrappers");
    assert.match(source, /controllerRecords\(children\)/, name+" must pass wrappers to cleanup");
  }
});
