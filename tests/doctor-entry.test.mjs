import test from "node:test";
import assert from "node:assert/strict";
import { doctorTabPath, resolveDoctorEntryTab } from "../src/lib/doctorEntry.ts";

test("direct ask links override a saved home or management tab without reading visitor storage", () => {
  for (const slug of ["tang-jinsong", "yu-wen", "new-public-agent"]) {
    for (const suffix of ["", "/"]) {
      assert.equal(resolveDoctorEntryTab(`/d/${slug}/ask${suffix}`, slug, () => assert.fail("Direct entry must not depend on stored state")), "ask");
    }
  }
});

test("ordinary agent links retain the existing session tab and tolerate unavailable storage", () => {
  assert.equal(resolveDoctorEntryTab("/d/tang-jinsong", "tang-jinsong", () => "manage"), "manage");
  assert.equal(resolveDoctorEntryTab("/d/tang-jinsong", "tang-jinsong", () => null), "home");
  assert.equal(resolveDoctorEntryTab("/d/tang-jinsong", "tang-jinsong", () => "invalid"), "home");
  assert.equal(resolveDoctorEntryTab("/d/tang-jinsong", "tang-jinsong", () => { throw new Error("Storage disabled"); }), "home");
});

test("a different agent or an unrelated nested path does not trigger question-page entry", () => {
  for (const path of ["/d/another-agent/ask", "/d/tang-jinsong/ask/private", "/d/tang-jinsong/task", "/d/tang-jinsong/%61sk"]) {
    assert.equal(resolveDoctorEntryTab(path, "tang-jinsong", () => null), "home");
  }
});

test("only the question tab gets a public subpage URL; other tabs keep their chosen session state", () => {
  assert.equal(doctorTabPath("tang-jinsong", "ask"), "/d/tang-jinsong/ask");
  for (const tab of ["home", "manage", "services", "me"]) assert.equal(doctorTabPath("tang-jinsong", tab), "/d/tang-jinsong");
});
