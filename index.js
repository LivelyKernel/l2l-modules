import {
  remove as removeHook,
  install as installHook,
  isInstalled as isHookInstalled
} from "lively.modules/src/hooks.js";

import {
  record as recordModuleEvent,
  subscribe, unsubscribe
} from "lively.modules/src/notify.js";

import * as modules from "lively.modules";

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// exports
// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

export {
  parseURL,
  fixL2lURL,
  fsRequest,
  initialize,
  getRemoteSubscribers,
  subscribeRemote, unsubscribeRemote
}

if (typeof lively !== "undefined") {
  lively.l2lModules = {
    fixL2lURL: fixL2lURL,
    fsRequest: fsRequest,
    initialize: initialize,
    subscribeRemote: subscribeRemote,
    unsubscribeRemote: unsubscribeRemote
  }
}


// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// setup
// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

function initialize(System, l2lSession) {
  installServices(System, l2lSession);
  prepareSystemForL2lFetch(System);
  setupRemoteNotifications(System, l2lSession)
}

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// helpers
// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

function fixL2lURL(url) {
  url = String(url);
  var [_, sessionId, path] = url.match(/^l2l:\/\/([^\/]+)\/(.*)/) || [];
  if (sessionId) {
    url = `l2l://${sessionId.replace(/:/, "__COLON__")}/${path}`;
  }
  return url;
}

function parseURL(url) {
  url = fixL2lURL(url);
  var realURL = new URL(url);
  if (!realURL.protocol === "l2l:") throw new Error(`Not a l2l url! ${url}`);

  var [_, sessionId, path] = String(url).match(/^l2l:\/\/([^\/]+)\/(.*)/) || [];
  sessionId = sessionId.replace(/:/, "__COLON__");

  return {
    url: realURL,
    sessionId: sessionId,
    path: path
  }
}


// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// remote subscriptions
// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

function setupRemoteNotifications(System, l2lSession) {
  subscribe(System, undefined, "l2l-modules-remote-notifications", event => {
    var moduleName = (event.options && event.options.targetModule)
                  || event.module;
    // HMMMM, only inform about local??? just filter for source?
    if (!moduleName.match(/^l2l:/))
      informRemoteSubscribers(System, l2lSession, event)
  });
}

function getRemoteSubscribers(System) {
  return modules.System["__l2l-modules__subscribers"]
      || (modules.System["__l2l-modules__subscribers"] = {});
}

function _localToL2lAddress(System, l2lSession, address) {
  if (address.indexOf(System.baseURL) !== 0) return address;
  var path = address.slice(System.baseURL.length).replace(/^\//, "");
  return `l2l://${l2lSession.sessionId}/${path}`;
}

function _makeSendable(System, event, l2lSession) {
  var sendable = lively.lang.obj.clone(event);
  sendable.isRemoteEvent = true;
  sendable.sourceSession = l2lSession.sessionId;
  if (sendable.type === "doitresult") {
    sendable.result = lively.morphic.printInspect(sendable.result, 1);
  }
  if (sendable.options && sendable.options.targetModule) {
    sendable.options = lively.lang.obj.clone(sendable.options);
    sendable.options.targetModule = _localToL2lAddress(System, l2lSession, sendable.options.targetModule);
  }
  if (sendable.module) {
    sendable.module = _localToL2lAddress(System, l2lSession, event.module);
  }
  return sendable;
}

function informRemoteSubscribers(System, l2lSession, event) {
  var sessionIds = Object.keys(getRemoteSubscribers(System));
  event = _makeSendable(System, event, l2lSession);
  return Promise.all(
    sessionIds.map(address =>
      new Promise((resolve, reject) =>
        l2lSession.sendTo(address, "l2l-modules.onModuleEvent", event,
          answer => resolve(answer)))))
}

function subscribeRemote(l2lSession, remoteSessionAddress) {
  return new Promise((resolve, reject) =>
    l2lSession.sendTo(remoteSessionAddress, "l2l-modules.addSubscriber", {}, resolve));
}

function unsubscribeRemote(l2lSession, remoteSessionAddress) {
  return new Promise((resolve, reject) =>
    l2lSession.sendTo(remoteSessionAddress, "l2l-modules.removeSubscriber", {}, resolve));
}

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// l2l modules
// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

function doL2lFetch(url, targetSessionId, path) {
  targetSessionId = targetSessionId.replace(/__COLON__/, ":");
  return new Promise((resolve, reject) => {
      var online = false;
      lively.net.SessionTracker.whenOnline(() => online = true);
      lively.lang.fun.waitFor(3000, () => online,
        (err) => err ? reject(new Error("lively-2-lively not online")) : resolve())
    })
    .then(() => new Promise((resolve, reject) =>
      lively.net.SessionTracker.getSession().sendTo(
        targetSessionId, "l2l-modules.fetch", {url: url, path: path}, resolve)))
    .then(answer => {
      var e = answer.error || answer.data.error;
      if (e) throw e;
      return answer.data.source;
    })
    .catch(err => {
      show(`l2l fetch of ${url} failed b/c \n${err.stack || err}`);
      throw err;
    });
}

function prepareSystemForL2lFetch(System) {
  if (!isHookInstalled(System, "normalize", 'l2lMakeConformantURL'))
    installHook(System, "normalize", function l2lMakeConformantURL(proceed, name, parent, parentAddress) {
      return proceed(name, parent, parentAddress).then(fixL2lURL); });

  if (!isHookInstalled(System, "normalizeSync", 'l2lMakeConformantURLSync'))
    installHook(System, "normalizeSync", function l2lMakeConformantURLSync(proceed, name, parent, isPlugin) {
      return fixL2lURL(proceed(name, parent, isPlugin)); });

  // lively.modules.System.fetch = lively.modules.System.fetch.getOriginal()

  if (!isHookInstalled(System, "fetch", 'l2lFetch'))
    installHook(System, "fetch", function l2lFetch(proceed, load) {
      var address = load.address || load.name || "",
          [_, sessionId, path] = address.match(/^l2l:\/\/([^\/]+)\/(.*)/) || [];
      return sessionId ? doL2lFetch(address, sessionId, path): proceed(load);
    });

  // lively.modules.installHook("fetch", function l2lFetchLog(proceed, load) {
  //   return proceed(load);
  // });

}

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// fs interface
// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

var timeout = 3000; /*ms*/

function fsRequest(url, method, options) {
  return new Promise((resolve, reject) => {
      var online = false;
      lively.net.SessionTracker.whenOnline(() => online = true);
      lively.lang.fun.waitFor(timeout, () => online,
        (err) => err ? reject(new Error("lively-2-lively not online")) : resolve())
    })

    .then(() => new Promise((resolve, reject) => {
      var target = parseURL(url),
          s = lively.net.SessionTracker.getSession(),
          data = lively.lang.obj.merge({path: target.path, cwd: undefined}, options),
          selector;

      switch (method.toLowerCase()) {
        case "exists": selector = "l2l-modules.fs.exists"; break;
        case "mkdir":  selector = "l2l-modules.fs.mkdir"; break;
        case "rm":     selector = "l2l-modules.fs.rm"; break;
        case "read":   selector = "l2l-modules.fs.read"; break;
        case "write":  selector = "l2l-modules.fs.write"; break;
        default:
          reject(new Error(`unknown l2l fs request method ${method}`));
          return;
      }

      s.sendTo(s.sessionId, selector, data, resolve);
    }))
    .then(answer => {
      if (answer.error || answer.data.error)
        throw answer.error || answer.data.error;
      switch (method.toLowerCase()) {
        case "exists": return answer.data.exists;
        case "mkdir":  return answer.data.status;
        case "rm":     return answer.data.status;
        case "read":   return answer.data.content;
        case "write":  return answer.data.status;
        default:
          throw new Error(`unknown l2l fs request method ${method}`)
      }
    });
}

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// services
// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

function expectData(fields, msg) {
  return new Promise((resolve, reject) => {
    for (var i = 0; i < fields.length; i++) {
      var name = fields[i];
      if (!msg.data.hasOwnProperty(name))
        return reject(new Error(`message data for ${msg.action} does not have required property ${name}`));
    }
    resolve(msg.data);
  });
}

function installServices(System, l2lSession) {
  l2lSession.addActions({

    "l2l-modules.fetch"(msg, session) {
      var S = msg.data.System ? modules.getSystem(msg.data.System) : System,
          packages, map, nonL2lPackages, nonL2lMap;
      prepareSystem();

      // FIXME 2: Since the stuff below is async, what if a local normalization
      // request happens while we are doing this here? ...we need a mutex... argh
      return expectData(["path"], msg)
        .then(data => modules.sourceOf(data.path, data.parent))
        .then(source => { resetSystem(); session.answer(msg, {source: source}); })
        .catch(err => { resetSystem(); session.answer(msg, {error: String(err.stack || err)}); })

      // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

      function prepareSystem() {
        // FIXME: when we do the normalization for msg.data.path we DO NOT want to
        // consider l2l urls that might be in our System.packages or System.map.
        // Therefor we gonna temporarily remove those while doing the source fetch.
        // Would be great to have better control over the normalization process...!!!
        packages = S.packages;
        map = S.map;
        nonL2lPackages = lively.lang.obj.clone(packages);
        nonL2lMap = lively.lang.obj.clone(map);
        Object.keys(nonL2lPackages).forEach(name =>
          name.indexOf("l2l://") === 0 && delete nonL2lPackages[name]);
        Object.keys(nonL2lMap).forEach(name =>
          String(nonL2lMap[name]).indexOf("l2l://") === 0 && delete nonL2lMap[name]);
        S.packages = nonL2lPackages;
        S.map = nonL2lMap;
      }

      function resetSystem() { S.packages = packages; S.map = map; }
    },

    "l2l-modules.onModuleEvent"(msg, session) {
      debugger;
      var S = msg.data.System ? modules.getSystem(msg.data.System) : System;
      recordModuleEvent(S, msg.data);
      session.answer(msg, {status: "recorded"});
    },

    "l2l-modules.addSubscriber"(msg, session) {
      var S = msg.data.System ? modules.getSystem(msg.data.System) : System,
          subscribers = getRemoteSubscribers(S),
          wasSubscribed = msg.sender in subscribers;
      subscribers[msg.sender] = {};
      session.answer(msg, {status: wasSubscribed ? "already subscribed" : "subscribed"});
    },

    "l2l-modules.removeSubscriber"(msg, session) {
      var S = msg.data.System ? modules.getSystem(msg.data.System) : System,
          subscribers = getRemoteSubscribers(S),
          wasSubscribed = msg.sender in subscribers;
      if (wasSubscribed) delete subscribers[msg.sender];
      session.answer(msg, {status: wasSubscribed ? "unsubscribed" : "not subscribed"});
    },

    "l2l-modules.fs.exists"(msg, session) {
      return expectData(["path"], msg)
        .then(data => new Promise((resolve, reject) =>
          lively.shell.run(
            `[[ -d ${data.path} || -f ${data.path} ]]`,
            {cwd: data.cwd},
            (_, cmd) => resolve(cmd.getCode() === 0))))
        .then(exists => session.answer(msg, {exists: exists}),
              err => session.answer(msg, {error: err}));
    },

    "l2l-modules.fs.mkdir"(msg, session) {
      return expectData(["path"], msg)
        .then(data => new Promise((resolve, reject) =>
          lively.shell.run("mkdir -p " + data.path,
            {cwd: data.cwd},
            (err, cmd) => err ? reject(err) : resolve())))
        .then(_ => session.answer(msg, {status: "created"}),
              err => session.answer(msg, {error: err}));
    },

    "l2l-modules.fs.rm"(msg, session) {
      return expectData(["path"], msg)
        .then(data => new Promise((resolve, reject) =>
          lively.shell.rm(data.path,
            {cwd: data.cwd},
            (err, cmd) => err ? reject(err) : resolve())))
        .then(_ => session.answer(msg, {status: "removed"}),
              err => session.answer(msg, {error: err}));
    },

    "l2l-modules.fs.write"(msg, session) {
      return expectData(["path", "content"], msg)
        .then(data => {
          var options = lively.lang.obj.merge({overwrite: true}, data.options);
          return new Promise((resolve, reject) =>
            // 1. Does file exist?
            (options.overwrite ?
              resolve() :
              lively.shell.run("test -f " + data.path,
                {cwd: data.cwd},
                (err, cmd) => resolve(cmd.getCode() === 0))))

           // 2. write file
            .then(exists => new Promise((resolve, reject) => {
              if (!options.overwrite && exists) resolve("not overwritten")
              else
                lively.shell.writeFile(data.path,
                  {content: data.content, cwd: data.cwd},
                  cmd => (!!cmd.getCode() ? reject(cmd.resultString(true)) : resolve(exists ? "overwritten" : "created")))
            }));
        })
        .then(status => session.answer(msg, {status: status}),
              err => session.answer(msg, {error: err}));
    },

    "l2l-modules.fs.read"(msg, session) {
      return expectData(["path"], msg)
        .then(data => new Promise((resolve, reject) =>
          lively.shell.cat(data.path,
          {cwd: data.cwd},
          (err, content) => err ? reject(err) : resolve(content))))
        .then(content => session.answer(msg, {content: content}),
              err => session.answer(msg, {error: err}));
    }

  });
}
