# frida-maui-unpin

Frida script to bypass certificate pinning in **.NET MAUI Android** apps running on the **unified .NET BCL** (`dotnet/runtime` MonoVM). Generic across any MAUI app — no app-specific class names required.

Forked from `frida-xamarin-unpin` (Frida-17–patched community fork of [`GoSecure/frida-xamarin-unpin`](https://github.com/GoSecure/frida-xamarin-unpin)).

---

## How it works

The script hooks `HttpMessageInvoker.SendAsync` and replaces the app's pinned `HttpClientHandler` with a fresh default handler. It then introspects the original handler's certificate validator via managed-delegate reflection and forces the validation callback to always return `true`.

**Four techniques in one script:**
1. **Modern path (Mono ≥ 6.0, Xamarin Classic):** `CreateDefaultHandler()` factory swap. Works on Xamarin.
2. **MAUI path (unified BCL, JIT or AOT):** `mono_object_new` + parameterless ctor + `_handler` swap + validator transfer + generic delegate introspection.
3. **SocketsHttpHandler path (`UseNativeHttpHandler=false`):** Walks `_settings._sslOptions` to find and hook `RemoteCertificateValidationCallback`.
4. **Legacy path (Mono < 6.0):** `ServicePointManager.ServerCertificateValidationCallback` nulling. Best-effort.

Also handles `DelegatingHandler` wrapper chains (`LifetimeTrackingHttpMessageHandler`, `LoggingScopeHttpMessageHandler`, `ResilienceHandler`, etc.) by unwrapping `_innerHandler` recursively.

No Java-layer hooks. Operates entirely at the Mono / managed layer. Set `const DEBUG = true` at the top of `src/main.js` for verbose field-enumeration diagnostics.

---

## Status

| Feature | Status |
|---|---|
| JIT-mode MAUI (`RunAOTCompilation=false`) |  Verified |
| AOT-mode MAUI (`RunAOTCompilation=true`) |  Verified on Android MonoVM |
| Generic (no app names) |  Stage 3 — delegate introspection |
| `UseNativeHttpHandler=true` (default) |  Supported |
| `UseNativeHttpHandler=false` (`SocketsHttpHandler`) |  Supported |
| `DelegatingHandler` wrappers (e.g. `LifetimeTrackingHttpMessageHandler`) |  Supported |
| iOS |  Not addressed |
| Early instrumentation (`frida -f`) |  Not supported (Mono modules must be loaded) |
| Verbose debug toggle |  `DEBUG` flag in `src/main.js` |

**AOT note:** `mono_compile_method` on Android MonoVM AOT returns the pre-compiled native entry point. `Interceptor.attach` patches it directly, the same as JIT. 

---

## Quick start

```bash
# 1. Build the bundled script
cd frida-maui-unpin
npm i && npm run build

# 2. Launch the app, wait for it to load, then attach
frida -U -p $(adb shell "pidof -s test.sample.aot") -l ./dist/maui-unpin.js

# 3. Trigger an HTTPS request in the app
```

Expected output with `DEBUG = false` (default, essential logs only):
```
[+] Hooked HttpMessageInvoker.SendAsync with mono_object_new technique (MAUI / unified BCL)
[+] Done!
Make sure you have a valid MITM CA installed on the device and have fun.
[+] Stage 3: hooked validator method (MonoMethod=0x..., name=ValidateCertificate, JIT=0x...), forced return=true
```

With `DEBUG = true`, field enumerations, class-name diagnostics, and handler unwrapping steps are also printed:
```
[*] HttpMessageInvoker.SendAsync called (MAUI path)
[*] existing _handler runtime class = LifetimeTrackingHttpMessageHandler
[*] unwrapped LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
[*] unwrapped LoggingScopeHttpMessageHandler -> SocketsHttpHandler
[*] SocketsHttpHandler detected — walking _settings._sslOptions for callback
...
```

Subsequent requests skip the Stage 3 hook installation (deduplicated by `_hookedMethods`).

---

## Test targets

| APK | Config | Status |
|---|---|---|
| `MAUI Sample Apk/test.sample.jit.apk` | JIT (`RunAOTCompilation=false`) |  Verified |
| `MAUI Sample Apk/test.sample.aot.apk` | AOT (`RunAOTCompilation=true`) |  Verified |

**Sample APK source:** `MAUI Sample Apk/` contains the test app used for validation. Based on the original test APK by Alexandre "alxbl" Beaulieu (GoSecure), rebuilt for latest .NET MAUI (`net9.0-android`). Includes both JIT and AOT build configurations. The source project is in `MAUI Sample Apk/SampleApp/` — the pre-built APKs are `test.sample.jit.apk` and `test.sample.aot.apk`.

---

## Forcing traffic through a proxy

Unpinning gets you past certificate validation, but some MAUI apps still won't
show up in Burp/mitmproxy because they **ignore the system proxy**. This happens
when the app builds its `SocketsHttpHandler` with a custom `_connectCallback`:
.NET then opens its own socket and skips the proxy-aware connection pool entirely,
so an Android/emulator proxy setting has no effect.

`src/maui-proxy.js` (standalone, no bundler / no `require`) fixes this by
patching the handler's `_settings` on the first `HttpMessageInvoker.SendAsync`:

- nulls `_connectCallback` so .NET falls back to its default, proxy-aware pool
- sets `_useProxy = true`
- injects a `WebProxy(host, port)` into `_proxy`

On aggressively-trimmed builds the `WebProxy` class is stripped from the BCL.
When it can't be found in any loaded assembly, the script falls back to
`setenv()` (`ALL_PROXY` / `HTTP_PROXY` / `HTTPS_PROXY`) and leaves `_proxy = null`,
so `SystemProxyInfo` reads the endpoint from the environment instead.

### Usage

Run in **spawn** mode — the connection pool is built lazily and can't be
re-pointed after the first request:

```bash
frida -U -f <package> -l ./src/maui-proxy.js
```

Set the target at the top of the file:

```js
var PROXY_HOST = "10.100.130.182";
var PROXY_PORT = 8080;
```

Pair it with the unpinning script (or trust the proxy CA on-device), since the
app will now TLS with the proxy's certificate.

| Scenario | Handled |
|---|---|
| `SocketsHttpHandler` + custom `_connectCallback` (ignores system proxy) | Yes |
| `DelegatingHandler` wrapper chains | Yes (recursive `_innerHandler` unwrap) |
| `WebProxy` present in BCL | Injects `WebProxy(host, port)` into `_proxy` |
| `WebProxy` trimmed out | `setenv` + `_proxy = null` (env-var proxy) |
| Attach mode (pool already built) | Not supported — spawn only |


---

## Building

Two-repo layout. `frida-mono-api-maui` is vendored as a sibling `file:` dependency:

```
parent/
├── frida-mono-api-maui/     ← ymuuuu/frida-mono-api-maui (standalone)
└── frida-maui-unpin/        ← this repo
```

```bash
cd frida-mono-api-maui && npm i
cd ../frida-maui-unpin && npm i && npm run build   # produces dist/maui-unpin.js
```

---

## Credits

- [@freehuntx](https://github.com/freehuntx) — original `frida-mono-api` and the Xamarin bypass concept.
- [GoSecure](https://github.com/GoSecure) — maintained `frida-xamarin-unpin` and the `extra` branch of `frida-mono-api`.
- [alxbl](https://github.com/alxbl) (`abeaulieu@gosecure.net`) — original author of `frida-xamarin-unpin`.

---


