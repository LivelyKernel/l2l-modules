/*global System, before, beforeEach, afterEach, describe, it*/

import { expect } from "mocha-es6";

import { getSystem, removeSystem } from "lively.modules";
import { install, uninstall, fsRequest } from "../index.js";

var dir = System.normalizeSync("l2l-modules/tests/"),
    relativeDir = (new URL(dir)).pathname.replace(/^\//, "");

describe("fs", () => {

  var session;
  before(() => session = lively.net.SessionTracker.getSession());

  var S;
  beforeEach(() => {
    S = getSystem("l2l-modules-fs-test");
    install(S, session);
  });

  afterEach(() => {
    uninstall(S, session);
    removeSystem("l2l-modules-fs-test");
  });

  it("reads file that exists", () =>
    fsRequest(`l2l://${session.sessionId}/${relativeDir}fs-test.js`, "read")
      .then(content => expect(content).to.match(/reads file that exists/)));

});
