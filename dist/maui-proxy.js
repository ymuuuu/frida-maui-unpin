"use strict";

var PROXY_HOST = "10.100.130.182"; //change it to your proxy zone
var PROXY_PORT = 8080;

var PROXY_URL = "http://" + PROXY_HOST + ":" + PROXY_PORT;
var NULL_CONNECT_CALLBACK = true;
var DEBUG = true;
function dbg() { if (DEBUG) console.log.apply(console, arguments); }
var psize = Process.pointerSize;
var __cbKeep = [];

(function () {
  try {
    var pSetenv = Module.findGlobalExportByName("setenv");
    if (!pSetenv) { console.log("[env] setenv !!!"); return; }
    var setenv = new NativeFunction(pSetenv, "int", ["pointer", "pointer", "int"]);
    var names = ["ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"];
    for (var i = 0; i < names.length; i++) {
      setenv(Memory.allocUtf8String(names[i]), Memory.allocUtf8String(PROXY_URL), 1);
    }
    console.log("[env] proxy env-vars was set  -> " + PROXY_URL);
  } catch (e) { console.log("[env] err: " + e); }
})();

var KNOWN_RUNTIMES = ["libmonosgen-2.0.so", "mono.dll", "libmonosgen-2.0.dylib"];
var mono = null;
for (var i = 0; i < KNOWN_RUNTIMES.length; i++) {
  var mm = Process.findModuleByName(KNOWN_RUNTIMES[i]);
  if (mm) { mono = mm; break; }
}
if (!mono) {
  var pa = Module.findGlobalExportByName("mono_thread_attach");
  if (pa) mono = Process.findModuleByAddress(pa);
}
if (!mono) throw new Error("[-] Mono runtime not found!");
dbg("[*] mono @ " + mono.name + " " + mono.base);

function E(name, ret, args) {
  var a = mono.findExportByName(name) || Module.findGlobalExportByName(name);
  if (!a) throw new Error("there is export: " + name);
  return new NativeFunction(a, ret, args);
}

var mono_get_root_domain            = E("mono_get_root_domain", "pointer", []);
var mono_thread_attach              = E("mono_thread_attach", "pointer", ["pointer"]);
var mono_domain_get                 = E("mono_domain_get", "pointer", []);
var mono_assembly_foreach           = E("mono_assembly_foreach", "void", ["pointer", "pointer"]);
var mono_assembly_get_image         = E("mono_assembly_get_image", "pointer", ["pointer"]);
var mono_image_get_name             = E("mono_image_get_name", "pointer", ["pointer"]);
var mono_class_from_name            = E("mono_class_from_name", "pointer", ["pointer", "pointer", "pointer"]);
var mono_class_get_methods          = E("mono_class_get_methods", "pointer", ["pointer", "pointer"]);
var mono_class_get_method_from_name = E("mono_class_get_method_from_name", "pointer", ["pointer", "pointer", "int"]);
var mono_class_get_field_from_name  = E("mono_class_get_field_from_name", "pointer", ["pointer", "pointer"]);
var mono_method_get_name            = E("mono_method_get_name", "pointer", ["pointer"]);
var mono_method_signature           = E("mono_method_signature", "pointer", ["pointer"]);
var mono_signature_get_param_count  = E("mono_signature_get_param_count", "uint32", ["pointer"]);
var mono_signature_get_params       = E("mono_signature_get_params", "pointer", ["pointer", "pointer"]);
var mono_type_get_name              = E("mono_type_get_name", "pointer", ["pointer"]);
var mono_field_get_value_object     = E("mono_field_get_value_object", "pointer", ["pointer", "pointer", "pointer"]);
var mono_field_set_value            = E("mono_field_set_value", "void", ["pointer", "pointer", "pointer"]);
var mono_object_get_class           = E("mono_object_get_class", "pointer", ["pointer"]);
var mono_class_get_name             = E("mono_class_get_name", "pointer", ["pointer"]);
var mono_object_new                 = E("mono_object_new", "pointer", ["pointer", "pointer"]);
var mono_runtime_invoke             = E("mono_runtime_invoke", "pointer", ["pointer", "pointer", "pointer", "pointer"]);
var mono_string_new                 = E("mono_string_new", "pointer", ["pointer", "pointer"]);
var mono_compile_method             = E("mono_compile_method", "pointer", ["pointer"]);
var mono_class_get_property_from_name = E("mono_class_get_property_from_name", "pointer", ["pointer", "pointer"]);
var mono_property_get_set_method    = E("mono_property_get_set_method", "pointer", ["pointer"]);

mono_thread_attach(mono_get_root_domain());
var domain = mono_domain_get();
if (domain.isNull()) domain = mono_get_root_domain();

function cstr(s) { return Memory.allocUtf8String(s); }
function newString(s) { return mono_string_new(domain, cstr(s)); }
function getField(k, n) { return mono_class_get_field_from_name(k, cstr(n)); }
function getFieldObj(f, o) { return mono_field_get_value_object(domain, f, o); }
function invoke(m, inst, argv) {
  var exc = Memory.alloc(psize); exc.writePointer(NULL);
  var r = mono_runtime_invoke(m, inst || NULL, argv || NULL, exc);
  if (!exc.readPointer().isNull()) dbg("[-] managed exception");
  return r;
}

function findClassEverywhere(ns, cls) {
  var out = { klass: NULL, asm: null };
  var cb = new NativeCallback(function (asmPtr, ud) {
    try {
      if (!out.klass.isNull()) return;
      var img = mono_assembly_get_image(asmPtr);
      var k = mono_class_from_name(img, cstr(ns), cstr(cls));
      if (!k.isNull()) {
        out.klass = k;
        out.asm = mono_image_get_name(img).readUtf8String();
      }
    } catch (e) {}
  }, "void", ["pointer", "pointer"]);
  __cbKeep.push(cb);
  mono_assembly_foreach(cb, NULL);
  return out;
}

function findCtor(klass, suffixes) {
  var iter = Memory.alloc(psize); iter.writePointer(NULL);
  var m;
  while (!(m = mono_class_get_methods(klass, iter)).isNull()) {
    if (mono_method_get_name(m).readUtf8String() !== ".ctor") continue;
    var sig = mono_method_signature(m);
    if (mono_signature_get_param_count(sig) !== suffixes.length) continue;
    var pit = Memory.alloc(psize); pit.writePointer(NULL);
    var ok = true, idx = 0, t;
    while (!(t = mono_signature_get_params(sig, pit)).isNull()) {
      var tn = mono_type_get_name(t).readUtf8String();
      if (idx >= suffixes.length || !tn.endsWith(suffixes[idx])) { ok = false; break; }
      idx++;
    }
    if (ok && idx === suffixes.length) return m;
  }
  return NULL;
}

function dumpCtors(klass) {
  var iter = Memory.alloc(psize); iter.writePointer(NULL);
  var m;
  while (!(m = mono_class_get_methods(klass, iter)).isNull()) {
    if (mono_method_get_name(m).readUtf8String() !== ".ctor") continue;
    var sig = mono_method_signature(m);
    var pit = Memory.alloc(psize); pit.writePointer(NULL);
    var t, names = [];
    while (!(t = mono_signature_get_params(sig, pit)).isNull())
      names.push(mono_type_get_name(t).readUtf8String());
    dbg("        .ctor(" + names.join(", ") + ")");
  }
}

var wpInfo = findClassEverywhere("System.Net", "WebProxy");
var kWebProxy = wpInfo.klass;
var webProxyCtorSI = NULL;   // (string,int)
var webProxyCtor0  = NULL;   // ()
var kUri = NULL, uriCtor = NULL, setAddrM = NULL;

if (kWebProxy.isNull()) {
  console.log("[proxy] there is not WebProxy class (it was trim) -> try env-var");
} else {
  console.log("[proxy] WebProxy found, assembly = " + wpInfo.asm + ", ctors:");
  dumpCtors(kWebProxy);
  webProxyCtorSI = findCtor(kWebProxy, ["String", "Int32"]);
  webProxyCtor0  = findCtor(kWebProxy, []);
  if (webProxyCtorSI.isNull() && !webProxyCtor0.isNull()) {
    var uInfo = findClassEverywhere("System", "Uri");
    kUri = uInfo.klass;
    if (!kUri.isNull()) uriCtor = findCtor(kUri, ["String"]);
    var addrProp = mono_class_get_property_from_name(kWebProxy, cstr("Address"));
    if (!addrProp.isNull()) setAddrM = mono_property_get_set_method(addrProp);
  }
}

function buildWebProxy() {
  var obj = mono_object_new(domain, kWebProxy);
  if (!webProxyCtorSI.isNull()) {
    var hostStr = newString(PROXY_HOST);
    var portSlot = Memory.alloc(4); portSlot.writeS32(PROXY_PORT);
    var args = Memory.alloc(2 * psize);
    args.writePointer(hostStr);
    args.add(psize).writePointer(portSlot);
    invoke(webProxyCtorSI, obj, args);
    return obj;
  }
  if (!webProxyCtor0.isNull() && !uriCtor.isNull() && !setAddrM.isNull()) {
    invoke(webProxyCtor0, obj, NULL);
    var uriObj = mono_object_new(domain, kUri);
    var uArg = Memory.alloc(psize); uArg.writePointer(newString(PROXY_URL));
    invoke(uriCtor, uriObj, uArg);
    var aArg = Memory.alloc(psize); aArg.writePointer(uriObj);
    invoke(setAddrM, obj, aArg);
    return obj;
  }
  return NULL;
}
function setRefField(o, f, v) { var s = Memory.alloc(psize); s.writePointer(v); mono_field_set_value(o, f, s); }
function setBoolField(o, f, v) { var s = Memory.alloc(1); s.writeU8(v ? 1 : 0); mono_field_set_value(o, f, s); }

function classFrom(imgScanNs, cls) { return findClassEverywhere(imgScanNs, cls).klass; }
var kInvoker = findClassEverywhere("System.Net.Http", "HttpMessageInvoker").klass;
if (kInvoker.isNull()) throw new Error("[-] HttpMessageInvoker not found");
var handlerField = getField(kInvoker, "_handler");
var sendM = mono_class_get_method_from_name(kInvoker, cstr("SendAsync"), -1);
if (sendM.isNull()) throw new Error("[-] SendAsync not found");
var injected = false;

Interceptor.attach(mono_compile_method(sendM), {
  onEnter: function (args) {
    if (injected) return;
    try {
      var self = args[0];
      var cur = getFieldObj(handlerField, self);
      if (cur.isNull()) return;
      var klass = mono_object_get_class(cur);
      while (true) {
        var innerF = getField(klass, "_innerHandler");
        if (innerF.isNull()) break;
        var inner = getFieldObj(innerF, cur);
        if (inner.isNull()) break;
        cur = inner; klass = mono_object_get_class(cur);
      }
      var clsName = mono_class_get_name(klass).readUtf8String();
      dbg("[proxy] real handler = " + clsName);
      if (clsName !== "SocketsHttpHandler") {
        console.log("[proxy] handler " + clsName + " - skip"); return;
      }

      var settings = getFieldObj(getField(klass, "_settings"), cur);
      if (settings.isNull()) { console.log("[proxy] _settings null"); return; }
      var sKlass = mono_object_get_class(settings);
      var useProxyF = getField(sKlass, "_useProxy");
      var proxyF    = getField(sKlass, "_proxy");
      var connF     = getField(sKlass, "_connectCallback");

      if (NULL_CONNECT_CALLBACK && !connF.isNull()) {
        setRefField(settings, connF, NULL);
        console.log("[proxy] _connectCallback was nulled");
      }
      if (!useProxyF.isNull()) setBoolField(settings, useProxyF, true);

      var wp = kWebProxy.isNull() ? NULL : buildWebProxy();
      if (!wp.isNull()) {
        if (!proxyF.isNull()) setRefField(settings, proxyF, wp);
        console.log("[proxy] WebProxy obj was enjected -> " + PROXY_URL);
      } else {
        // WebProxy yok -> _proxy'yi null birak, SystemProxyInfo env'i okusun
        if (!proxyF.isNull()) setRefField(settings, proxyF, NULL);
        console.log("[proxy] WebProxy none -> _proxy=null, trying env-var(" + PROXY_URL + ")");
      }

      injected = true;
      console.log("[proxy] done - _useProxy=true");
    } catch (e) {
      console.log("[proxy] err: " + e + "\n" + e.stack);
    }
  }
});

console.log("[proxy] hooked, target = " + PROXY_URL);
