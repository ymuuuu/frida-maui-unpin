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
const mono = MonoApi.module


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
            console.log(`[*] HttpClientHandler.SendAsync called`);

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
        console.log('[*] Stage 2.2: enumerating HttpClientHandler methods');
        MonoApiHelper.ClassGetMethods(kHandler).forEach(m => {
            console.log(`        method: ${MonoApi.mono_method_get_name(m).readUtf8String()}`);
        });
        console.log('[*] Stage 2.2: enumerating HttpClientHandler fields');
        MonoApiHelper.ClassGetFields(kHandler).forEach(f => {
            console.log(`        field:  ${MonoApi.mono_field_get_name(f).readUtf8String()}`);
        });

        // Stage 2.3: hoist _nativeUnderlyingHandler field handle to attach time so the
        // per-call onEnter can read/write the underlying handler without re-resolving.
        let _underlyingField = MonoApiHelper.ClassGetFieldFromName(kHandler, '_nativeUnderlyingHandler');
        if (_underlyingField.isNull()) {
            console.log('[-] _nativeUnderlyingHandler field not found on HttpClientHandler at attach time');
        }

        // Stage 2.3: hook MauiProgram.ValidateCertificate's compiled IL to force return=true.
        // Combined with the per-call validator transfer below, this routes the SSL handshake
        // through AndroidMessageHandler's custom-validator branch (instead of system trust)
        // and short-circuits the validator's return value to "trust this cert."
        // APK-specific: names SampleApp.MauiProgram.ValidateCertificate. Generic-MAUI handling
        // would need JS-supplied managed-delegate construction (the frida-mono-maui-api gap).
        let appAsm = MonoApi.mono_assembly_load_with_partial_name(Memory.allocUtf8String('SampleApp'), status);
        if (appAsm.isNull()) {
            console.log('[-] SampleApp assembly not found — Stage 2.3 IL hook skipped');
        } else {
            let appImg = MonoApi.mono_assembly_get_image(appAsm);
            let kMaui = MonoApi.mono_class_from_name(appImg, Memory.allocUtf8String('SampleApp'), Memory.allocUtf8String('MauiProgram'));
            if (kMaui.isNull()) {
                console.log('[-] SampleApp.MauiProgram class not found — Stage 2.3 IL hook skipped');
            } else {
                let validate = MonoApiHelper.ClassGetMethodFromName(kMaui, 'ValidateCertificate', -1);
                if (validate.isNull()) {
                    console.log('[-] MauiProgram.ValidateCertificate not found — Stage 2.3 IL hook skipped');
                } else {
                    let validateImpl = MonoApi.mono_compile_method(validate);
                    Interceptor.attach(validateImpl, {
                        onLeave: (retval) => {
                            retval.replace(ptr(1));
                        }
                    });
                    console.log('[+] Stage 2.3: hooked MauiProgram.ValidateCertificate, forcing return=true');
                }
            }
        }

        // Stage 2.3: validator field handle resolved lazily on first SendAsync from the
        // live underlying handler's runtime class — avoids hardcoding the
        // Xamarin.Android.Net.AndroidMessageHandler assembly name at attach time.
        let _validatorField = null;

        let _underlyingEnumerated = false;

        MonoApiHelper.Intercept(kInvoker, 'SendAsync', {
            onEnter: (args) => {
                console.log(`[*] HttpMessageInvoker.SendAsync called (MAUI path)`);

                let self = args[0];
                let handler = MonoApiHelper.ClassGetFieldFromName(kInvoker, '_handler');
                let cur = MonoApiHelper.FieldGetValueObject(handler, self);
                if (INJECTED[cur]) return;

                // Diagnostic: confirm what we're working with so the next stage has ground truth.
                // NOTE: MonoApiHelper.ClassGetName uses the legacy Memory.readUtf8String which
                // Frida 17 removed; resolve directly via the instance method instead.
                let curKlass = MonoApiHelper.ObjectGetClass(cur);
                console.log(`[*] existing _handler runtime class = ${MonoApi.mono_class_get_name(curKlass).readUtf8String()}`);

                // Stage 2.2: once per script load, walk into the existing handler's
                // _nativeUnderlyingHandler and enumerate its fields. We can't do this at
                // attach time because there's no instance to read the field value from.
                if (!_underlyingEnumerated) {
                    _underlyingEnumerated = true;
                    let undField = MonoApiHelper.ClassGetFieldFromName(kHandler, '_nativeUnderlyingHandler');
                    if (undField.isNull()) {
                        console.log('[-] _nativeUnderlyingHandler field not found on HttpClientHandler');
                    } else {
                        let und = MonoApiHelper.FieldGetValueObject(undField, cur);
                        if (und.isNull()) {
                            console.log('[-] _nativeUnderlyingHandler is NULL on existing _handler');
                        } else {
                            let undKlass = MonoApiHelper.ObjectGetClass(und);
                            console.log(`[*] underlying handler runtime class = ${MonoApi.mono_class_get_name(undKlass).readUtf8String()}`);
                            console.log('[*] enumerating underlying handler fields:');
                            MonoApiHelper.ClassGetFields(undKlass).forEach(f => {
                                console.log(`        field:  ${MonoApi.mono_field_get_name(f).readUtf8String()}`);
                            });
                        }
                    }
                }

                let fresh = MonoApi.mono_object_new(domain, kHandler);
                MonoApiHelper.RuntimeInvoke(kHandlerCtor, fresh);
                console.log(`[+] New HttpClientHandler VA=${fresh}`);

                let freshKlass = MonoApiHelper.ObjectGetClass(fresh);
                console.log(`[*] fresh handler runtime class = ${MonoApi.mono_class_get_name(freshKlass).readUtf8String()}`);

                MonoApi.mono_field_set_value(self, handler, fresh);
                console.log(`[+] Injected fresh handler for Client=${self}`);

                // Stage 2.3: copy the old underlying handler's _serverCertificateCustomValidator
                // pointer onto the fresh underlying handler. Without this, the fresh underlying
                // has a NULL validator and AndroidMessageHandler.SetupSSL() falls back to
                // Android's system trust manager, which rejects user-installed CAs on Android 7+.
                // With the validator copied across, SetupSSL takes the custom-validator branch
                // and invokes MauiProgram.ValidateCertificate — which the IL hook above forces
                // to return true. Net effect: any cert is accepted.
                if (!_underlyingField.isNull()) {
                    let oldUnd = MonoApiHelper.FieldGetValueObject(_underlyingField, cur);
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
let net = MonoApi.mono_assembly_load_with_partial_name(Memory.allocUtf8String('System'), status);
let imgNet = MonoApi.mono_assembly_get_image(net);
let kSvc = MonoApiHelper.ClassFromName(imgNet, 'System.Net.ServicePointManager');
let kCb = MonoApiHelper.ClassFromName(imgNet, 'System.Net.Security.RemoteCertificateValidationCallback')

let validationCallback = MonoApi.mono_class_get_property_from_name(kSvc, Memory.allocUtf8String('ServerCertificateValidationCallback'))
if (!hooked && !validationCallback.isNull()) {
    console.log(`[*] ServerCertificateValidationCallback @ ${validationCallback}`)

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

if (hooked) console.log('[+] Done!\nMake sure you have a valid MITM CA installed on the device and have fun.');
else console.log('[-] Failed to apply any bypass techniques... is this really Xamarin?')
