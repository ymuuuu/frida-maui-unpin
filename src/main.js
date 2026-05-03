/* Xamarin/Android HttpClient generic certificate pinning bypass.
 *
 * @author     Alexandre "alxbl" Beaulieu <abeaulieu@gosecure.net>
 * @release    Jan 28th 2020
 *
 * @description
 *
 * This script is a generic certificate pinning bypass for Android applications
 * that use Xamarin with Mono.
 *
 * There are two methods to override the server certificate validation step in .NET
 * depending on whether the classic .NET API is being used (`ServicePointerManager`)
 * or the .NET Core APIs are being used (`HttpClient.HttpClientHandler`).
 *
 * In the .NET Core case, the HttpClient's `SendAsync` implementation is hooked to 
 * inject * a default HttpClientHandler that does not perform pinning. 
 *
 * In the .NET Framework case, the System.Net.ServicePointerManager's is hooked
 * to always return NULL and forcefully set to NULL in order to reset it.
 *
 * @note    Validation still happens so the certificate must be valid.
 */

import { MonoApiHelper, MonoApi } from 'frida-mono-api'
import { MonoApiMauiHelper } from 'frida-mono-api-maui'
const mono = MonoApi.module

// Toggle verbose diagnostic output in Frida console.
const DEBUG = true;
function dbg(...args) { if (DEBUG) console.log(...args); }

// Locate System.Net.Http.dll
let status = Memory.alloc(0x1000);
let hooked = false;

// Mono 6.0+: Construct a default HttpClientHandler to inject in HttpMessageInvoker instances.
let http = MonoApi.mono_assembly_load_with_partial_name(Memory.allocUtf8String('System.Net.Http'), status);
let img = MonoApi.mono_assembly_get_image(http);
let kHandler = MonoApi.mono_class_from_name(img, Memory.allocUtf8String('System.Net.Http'), Memory.allocUtf8String('HttpClientHandler'));
let ctor = MonoApiHelper.ClassGetMethodFromName(kHandler, 'CreateDefaultHandler');

let INJECTED = {} // Keep track of injected handlers.

if (kHandler && !ctor.isNull()) {

    // Hook HttpMessageInvoker.SendAsync
    let kInvoker = MonoApi.mono_class_from_name(img, Memory.allocUtf8String('System.Net.Http'), Memory.allocUtf8String('HttpMessageInvoker'));

    MonoApiHelper.Intercept(kInvoker, 'SendAsync', {
        onEnter: (args) => {
            dbg(`[*] HttpClientHandler.SendAsync called`);

            let self = args[0];
            let handler = MonoApiHelper.ClassGetFieldFromName(kInvoker, '_handler');
            let cur = MonoApiHelper.FieldGetValueObject(handler, self);
            if (INJECTED[cur]) return; // Already bypassed.

            // Create a new handler per HttpClient to avoid dispose() causing a crash.
            let pClientHandler = MonoApiHelper.RuntimeInvoke(ctor, NULL); // instance is NULL for static methods.
            console.log(`[+] New HttpClientHandler VA=${pClientHandler}`);

            MonoApi.mono_field_set_value(self, handler, pClientHandler);
            console.log(`[+] Injected default handler for Client=${self}`);
            INJECTED[pClientHandler] = true; // TODO: cleanup on HttpClient dispose.
        }
    });
    console.log('[+] Hooked HttpMessageInvoker.SendAsync with DefaultHttpClientHandler technique');
    hooked = true;
} else if (kHandler && ctor.isNull()) {
    // MAUI / unified BCL: no static CreateDefaultHandler factory. Allocate via mono_object_new
    // and run the parameterless instance ctor instead. Fresh handler has no
    // ServerCertificateCustomValidationCallback, so the app's pinning callback is bypassed.
    let kHandlerCtor = MonoApiHelper.ClassGetMethodFromName(kHandler, '.ctor', 0);
    if (kHandlerCtor.isNull()) {
        console.log('[-] HttpClientHandler parameterless ctor not found — cannot proceed');
    } else {
        let kInvoker = MonoApi.mono_class_from_name(img, Memory.allocUtf8String('System.Net.Http'), Memory.allocUtf8String('HttpMessageInvoker'));
        let domain = MonoApi.mono_domain_get();

        // Stage 2.2: enumerate methods + fields declared on HttpClientHandler so the next
        // stage can pick the smallest callback-install primitive based on real ground truth
        // (not guesses about argCnt or naming). Frida 17 removed Memory.readUtf8String, so
        // resolve names via the NativePointer instance method directly instead of going
        // through MonoApiHelper.{MethodGetName,FieldGetName} which still call the dead API.
        dbg('[*] Stage 2.2: enumerating HttpClientHandler methods');
        MonoApiHelper.ClassGetMethods(kHandler).forEach(m => {
            dbg(`        method: ${MonoApi.mono_method_get_name(m).readUtf8String()}`);
        });
        dbg('[*] Stage 2.2: enumerating HttpClientHandler fields');
        MonoApiHelper.ClassGetFields(kHandler).forEach(f => {
            dbg(`        field:  ${MonoApi.mono_field_get_name(f).readUtf8String()}`);
        });

        // Stage 2.3: hoist _nativeUnderlyingHandler field handle to attach time so the
        // per-call onEnter can read/write the underlying handler without re-resolving.
        let _underlyingField = MonoApiHelper.ClassGetFieldFromName(kHandler, '_nativeUnderlyingHandler');
        if (_underlyingField.isNull()) {
            console.log('[-] _nativeUnderlyingHandler field not found on HttpClientHandler at attach time');
        }

        // Stage 3: generalize the cert-validation override. Instead of naming the app's
        // validator method (Stage 2.3 hardcoded the test APK's namespace + class + method),
        // we walk the existing validator instance's <Callback>k__BackingField -> Func<...>
        // -> MonoMethod* -> JIT entry at runtime and Interceptor.attach onLeave to force
        // return=true. Same architectural shape as Stage 2.3 (validator transfer + return
        // override) but no app-specific class names. Works on any MAUI Android app whose
        // HttpClientHandler installs a custom ServerCertificateCustomValidationCallback.
        // Per-call hook installation is deduplicated via _hookedMethods so multiple
        // HttpClient instances or lazy-init validators each get their callback method
        // hooked exactly once.
        let _hookedMethods = new Set();

        // Stage 2.3: validator field handle resolved lazily on first SendAsync from the
        // live underlying handler's runtime class — avoids hardcoding the
        // Xamarin.Android.Net.AndroidMessageHandler assembly name at attach time.
        let _validatorField = null;

        let _underlyingEnumerated = false;

        MonoApiHelper.Intercept(kInvoker, 'SendAsync', {
            onEnter: (args) => {
                dbg(`[*] HttpMessageInvoker.SendAsync called (MAUI path)`);

                let self = args[0];
                let handler = MonoApiHelper.ClassGetFieldFromName(kInvoker, '_handler');
                let cur = MonoApiHelper.FieldGetValueObject(handler, self);
                if (INJECTED[cur]) return;

                // Diagnostic: confirm what we're working with so the next stage has ground truth.
                // NOTE: MonoApiHelper.ClassGetName uses the legacy Memory.readUtf8String which
                // Frida 17 removed; resolve directly via the instance method instead.
                let curKlass = MonoApiHelper.ObjectGetClass(cur);
                let curClassName = MonoApi.mono_class_get_name(curKlass).readUtf8String();
                dbg(`[*] existing _handler runtime class = ${curClassName}`);

                // ---- Unwrap DelegatingHandler wrappers (e.g. LifetimeTrackingHttpMessageHandler) ----
                // Walk the _innerHandler chain by resolving the field on the *runtime* class of
                // each wrapper.  Using a single field handle from DelegatingHandler on a
                // non-DelegatingHandler class reads the wrong memory offset and keeps going
                // forever (or until a null/non-object dereference).
                let unwrapped = cur;
                let unwrappedKlass = curKlass;
                while (true) {
                    let innerField = MonoApiHelper.ClassGetFieldFromName(unwrappedKlass, '_innerHandler');
                    if (innerField.isNull()) break;
                    let inner = MonoApiHelper.FieldGetValueObject(innerField, unwrapped);
                    if (inner.isNull()) break;
                    let name = MonoApi.mono_class_get_name(unwrappedKlass).readUtf8String();
                    unwrapped = inner;
                    unwrappedKlass = MonoApiHelper.ObjectGetClass(unwrapped);
                    dbg(`[*] unwrapped ${name} -> ${MonoApi.mono_class_get_name(unwrappedKlass).readUtf8String()}`);
                }
                let realHandler = unwrapped;
                let realHandlerKlass = unwrappedKlass;
                let realClassName = MonoApi.mono_class_get_name(realHandlerKlass).readUtf8String();

                // ---- SocketsHttpHandler path (e.g. UseNativeHttpHandler=false or non-MAUI) ----
                if (realClassName === 'SocketsHttpHandler') {
                    dbg('[*] SocketsHttpHandler detected — walking _settings._sslOptions for callback');
                    let hookedCallback = false;
                    let settingsField = MonoApiHelper.ClassGetFieldFromName(realHandlerKlass, '_settings');
                    if (!settingsField.isNull()) {
                        let settings = MonoApiHelper.FieldGetValueObject(settingsField, realHandler);
                        if (!settings.isNull()) {
                            let settingsKlass = MonoApiHelper.ObjectGetClass(settings);
                            let sslOptionsField = MonoApiHelper.ClassGetFieldFromName(settingsKlass, '_sslOptions');
                            if (!sslOptionsField.isNull()) {
                                let sslOptions = MonoApiHelper.FieldGetValueObject(sslOptionsField, settings);
                                if (!sslOptions.isNull()) {
                                    let sslOptionsKlass = MonoApiHelper.ObjectGetClass(sslOptions);
                                    let callbackField = MonoApiHelper.ClassGetFieldFromName(sslOptionsKlass, '<RemoteCertificateValidationCallback>k__BackingField');
                                    if (!callbackField.isNull()) {
                                        let callback = MonoApiHelper.FieldGetValueObject(callbackField, sslOptions);
                                        if (!callback.isNull()) {
                                            let method = MonoApiMauiHelper.DelegateGetMethod(callback);
                                            if (!method.isNull()) {
                                                let key = method.toString();
                                                if (!_hookedMethods.has(key)) {
                                                    let entry = MonoApiMauiHelper.CompileMethod(method);
                                                    Interceptor.attach(entry, {
                                                        onLeave: (retval) => { retval.replace(ptr(1)); }
                                                    });
                                                    _hookedMethods.add(key);
                                                    console.log(`[+] Stage 3: hooked SocketsHttpHandler callback (MonoMethod=${method}, name=${MonoApiMauiHelper.MethodGetName(method)}, JIT=${entry}), forced return=true`);
                                                }
                                                hookedCallback = true;
                                            } else {
                                                console.log('[-] Stage 3: SocketsHttpHandler callback delegate method NULL');
                                            }
                                        } else {
                                            console.log('[-] RemoteCertificateValidationCallback backing field is null');
                                        }
                                    } else {
                                        console.log('[-] <RemoteCertificateValidationCallback>k__BackingField not found on SslClientAuthenticationOptions');
                                    }
                                } else {
                                    console.log('[-] _sslOptions is null on HttpConnectionSettings');
                                    // Diagnostic: enumerate all fields on HttpConnectionSettings
                                    // to check for alternative SSL-related storage.
                                    dbg('[*] enumerating HttpConnectionSettings fields:');
                                    MonoApiHelper.ClassGetFields(settingsKlass).forEach(f => {
                                        dbg(`        field:  ${MonoApi.mono_field_get_name(f).readUtf8String()}`);
                                    });
                                    // Also check _connectCallback — custom connection logic might do its own TLS.
                                    let connectCallbackField = MonoApiHelper.ClassGetFieldFromName(settingsKlass, '_connectCallback');
                                    if (!connectCallbackField.isNull()) {
                                        let connectCallback = MonoApiHelper.FieldGetValueObject(connectCallbackField, settings);
                                        dbg(`[*] _connectCallback = ${connectCallback} (null=${connectCallback.isNull()})`);
                                    }
                                }
                            } else {
                                console.log('[-] _sslOptions field not found on HttpConnectionSettings');
                            }
                        } else {
                            console.log('[-] _settings is null on SocketsHttpHandler');
                        }
                    } else {
                        console.log('[-] _settings field not found on SocketsHttpHandler');
                    }
                    if (!hookedCallback) {
                        console.log('[-] Could not find/hook SocketsHttpHandler callback — pinning may still be active');
                    }
                    INJECTED[cur] = true;
                    return;
                }

                // ---- HttpClientHandler path (MAUI default with UseNativeHttpHandler=true) ----

                // Stage 2.2: once per script load, walk into the existing handler's
                // _nativeUnderlyingHandler and enumerate its fields. We can't do this at
                // attach time because there's no instance to read the field value from.
                if (!_underlyingEnumerated) {
                    _underlyingEnumerated = true;
                    let undField = MonoApiHelper.ClassGetFieldFromName(realHandlerKlass, '_nativeUnderlyingHandler');
                    if (undField.isNull()) {
                        console.log('[-] _nativeUnderlyingHandler field not found on existing handler class');
                    } else {
                        let und = MonoApiHelper.FieldGetValueObject(undField, realHandler);
                        if (und.isNull()) {
                            console.log('[-] _nativeUnderlyingHandler is NULL on existing _handler');
                        } else {
                            let undKlass = MonoApiHelper.ObjectGetClass(und);
                            dbg(`[*] underlying handler runtime class = ${MonoApi.mono_class_get_name(undKlass).readUtf8String()}`);
                            dbg('[*] enumerating underlying handler fields:');
                            MonoApiHelper.ClassGetFields(undKlass).forEach(f => {
                                dbg(`        field:  ${MonoApi.mono_field_get_name(f).readUtf8String()}`);
                            });
                        }
                    }
                }

                let fresh = MonoApi.mono_object_new(domain, kHandler);
                MonoApiHelper.RuntimeInvoke(kHandlerCtor, fresh);
                console.log(`[+] New HttpClientHandler VA=${fresh}`);

                let freshKlass = MonoApiHelper.ObjectGetClass(fresh);
                dbg(`[*] fresh handler runtime class = ${MonoApi.mono_class_get_name(freshKlass).readUtf8String()}`);

                MonoApi.mono_field_set_value(self, handler, fresh);
                console.log(`[+] Injected fresh handler for Client=${self}`);

                // Stage 2.3: copy the old underlying handler's _serverCertificateCustomValidator
                // pointer onto the fresh underlying handler. Without this, the fresh underlying
                // has a NULL validator and AndroidMessageHandler.SetupSSL() falls back to
                // Android's system trust manager, which rejects user-installed CAs on Android 7+.
                // With the validator copied across, SetupSSL takes the custom-validator branch
                // and invokes the wrapped Func<...> — whose return is forced to true by the
                // Stage 3 generic hook installed below. Net effect: any cert is accepted.
                if (!_underlyingField.isNull()) {
                    let oldUnd = MonoApiHelper.FieldGetValueObject(_underlyingField, realHandler);
                    let freshUnd = MonoApiHelper.FieldGetValueObject(_underlyingField, fresh);
                    if (oldUnd.isNull() || freshUnd.isNull()) {
                        console.log('[-] underlying handler NULL on old or fresh — validator transfer skipped');
                    } else {
                        if (_validatorField === null) {
                            let undKlass = MonoApiHelper.ObjectGetClass(oldUnd);
                            _validatorField = MonoApiHelper.ClassGetFieldFromName(undKlass, '_serverCertificateCustomValidator');
                            if (_validatorField.isNull()) {
                                console.log('[-] _serverCertificateCustomValidator field not found on underlying handler');
                            }
                        }
                        if (_validatorField && !_validatorField.isNull()) {
                            let oldVal = MonoApiHelper.FieldGetValueObject(_validatorField, oldUnd);
                            MonoApi.mono_field_set_value(freshUnd, _validatorField, oldVal);
                            console.log(`[+] Transferred _serverCertificateCustomValidator (val=${oldVal}) from old underlying to fresh`);
                        }
                    }
                }

                // Stage 3: walk the existing validator -> Func<...> -> MonoMethod* -> JIT entry,
                // and Interceptor.attach onLeave to force return=true. Generic across any MAUI
                // app: the validator instance is Xamarin.Android.Net.ServerCertificateCustomValidator
                // (BCL-shipped), its <Callback>k__BackingField is the user-supplied Func, and the
                // MonoDelegate ARM64-LP64 layout puts the wrapped MonoMethod* at +0x28 (stable
                // across mono/mono and dotnet/runtime forks). Dedup by MonoMethod* so multiple
                // HttpClients or lazy-init validators each get hooked once.
                if (!_underlyingField.isNull() && _validatorField && !_validatorField.isNull()) {
                    let oldUndForHook = MonoApiHelper.FieldGetValueObject(_underlyingField, realHandler);
                    if (!oldUndForHook.isNull()) {
                        let validator = MonoApiHelper.FieldGetValueObject(_validatorField, oldUndForHook);
                        if (!validator.isNull()) {
                            let callbackField = MonoApiMauiHelper.GetCallbackField(validator);
                            if (callbackField && !callbackField.isNull()) {
                                let func = MonoApiHelper.FieldGetValueObject(callbackField, validator);
                                if (!func.isNull()) {
                                    let method = MonoApiMauiHelper.DelegateGetMethod(func);
                                    if (!method.isNull()) {
                                        let key = method.toString();
                                        if (!_hookedMethods.has(key)) {
                                            let entry = MonoApiMauiHelper.CompileMethod(method);
                                            Interceptor.attach(entry, {
                                                onLeave: (retval) => { retval.replace(ptr(1)); }
                                            });
                                            _hookedMethods.add(key);
                                            console.log(`[+] Stage 3: hooked validator method (MonoMethod=${method}, name=${MonoApiMauiHelper.MethodGetName(method)}, JIT=${entry}), forced return=true`);
                                        }
                                    } else {
                                        console.log('[-] Stage 3: delegate method NULL — introspection failed at MonoMethod step');
                                    }
                                } else {
                                    console.log('[-] Stage 3: validator <Callback>k__BackingField value NULL — introspection failed');
                                }
                            } else {
                                console.log('[-] Stage 3: <Callback>k__BackingField not found on validator class');
                            }
                        } else {
                            console.log('[-] Stage 3: validator NULL on existing underlying — introspection skipped');
                            // Diagnostic: check if app uses TrustedCerts pinning instead
                            let trustedCertsField = MonoApiHelper.ClassGetFieldFromName(MonoApiHelper.ObjectGetClass(oldUndForHook), '<TrustedCerts>k__BackingField');
                            if (!trustedCertsField.isNull()) {
                                let trustedCerts = MonoApiHelper.FieldGetValueObject(trustedCertsField, oldUndForHook);
                                dbg(`[*] TrustedCerts value = ${trustedCerts} (null=${trustedCerts.isNull()})`);
                            }
                        }
                    }
                }

                INJECTED[fresh] = true;
            }
        });
        console.log('[+] Hooked HttpMessageInvoker.SendAsync with mono_object_new technique (MAUI / unified BCL)');
        hooked = true;
    }
} else {
    console.log('[-] HttpClientHandler not found (Mono < 6.0?)');
}

// Mono < 6.0: Hook the ServicePointManager.
//             since the API is still there but unused.
// [TODO] This is currently untested. If you have an APK that uses an
//        older mono version and are getting errors, see the TODO
//        tags.
if (!hooked) {
    let net = MonoApi.mono_assembly_load_with_partial_name(Memory.allocUtf8String('System'), status);
    if (!net.isNull()) {
        let imgNet = MonoApi.mono_assembly_get_image(net);
        if (!imgNet.isNull()) {
            let kSvc = MonoApiHelper.ClassFromName(imgNet, 'System.Net.ServicePointManager');
            let kCb = MonoApiHelper.ClassFromName(imgNet, 'System.Net.Security.RemoteCertificateValidationCallback')

            if (!kSvc.isNull()) {
                let validationCallback = MonoApi.mono_class_get_property_from_name(kSvc, Memory.allocUtf8String('ServerCertificateValidationCallback'))
                if (!validationCallback.isNull()) {
                    dbg(`[*] ServerCertificateValidationCallback @ ${validationCallback}`)

                    let setter = MonoApi.mono_property_get_set_method(validationCallback)
                    let getter = MonoApi.mono_property_get_set_method(validationCallback)

                    if (setter && getter) {
                        MonoApiHelper.RuntimeInvoke(setter, /*instance=*/NULL, /*pArgs=*/NULL); // TODO: pArgs?
                        console.log('[+] Set ServerCertificateValidationCallback to NULL');

                        // Hook get and set to always return / set NULL.
                        // TODO: Expose overload in frida-mono-api ?
                        pSet = MonoApi.mono_compile_method(setter)
                        pGet = MonoApi.mono_compile_method(getter)
                        Interceptor.attach(pSet, {
                            onEnter: (args) => {
                                // TODO: Need valid args[] with a NULL entry?
                                args[1] = NULL;
                            }
                        });

                        Interceptor.attach(pGet, {
                            onLeave: (ret) => {
                                // TODO: Need valid args[] with a NULL entry? Or mono_box_value?
                                ret = NULL;
                            }
                        });

                        console.log('[+] Hooked ServerCertificateValidationCallback with get/set technique')
                        hooked = true;
                    } else {
                        console.log('[-] Getter/Setter not found for ServerCertificateValidationCallback')
                    }
                } else {
                    console.log('[-] ServicePointManager validation callback not found.');
                }
            } else {
                console.log('[-] ServicePointManager class not found in System assembly');
            }
        } else {
            console.log('[-] System assembly image is NULL');
        }
    } else {
        console.log('[-] System assembly not found (unified BCL — expected)');
    }
}

if (hooked) console.log('[+] Done!\nMake sure you have a valid MITM CA installed on the device and have fun.');
else console.log('[-] Failed to apply any bypass techniques... is this really Xamarin?')
