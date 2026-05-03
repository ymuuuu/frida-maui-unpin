using System.Net.Http;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using Microsoft.Extensions.Logging;

namespace SampleApp;

public static class MauiProgram
{
    public static MauiApp CreateMauiApp()
    {
        var builder = MauiApp.CreateBuilder();
        builder
            .UseMauiApp<App>()
            .ConfigureFonts(fonts =>
            {
                fonts.AddFont("OpenSans-Regular.ttf", "OpenSansRegular");
                fonts.AddFont("OpenSans-Semibold.ttf", "OpenSansSemibold");
            });

        builder.Services.AddSingleton<ILogger, Logger>();
        builder.Services.AddSingleton<HttpClient>(sp =>
        {
            var handler = new HttpClientHandler();
            handler.ServerCertificateCustomValidationCallback = ValidateCertificate;
            var bf = System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance;
            var und = handler.GetType().GetField("_nativeUnderlyingHandler", bf)?.GetValue(handler);
            var sock = handler.GetType().GetField("_socketHandler", bf)?.GetValue(handler);
            Android.Util.Log.Verbose("PINNING", $"handler={handler.GetType().FullName} _nativeUnderlyingHandler={und?.GetType().FullName ?? "null"} _socketHandler={sock?.GetType().FullName ?? "null"}");
            return new HttpClient(handler);
        });

#if DEBUG
        builder.Logging.AddDebug();
#endif

        return builder.Build();
    }

    private static bool ValidateCertificate(object sender, X509Certificate certificate, X509Chain chain, SslPolicyErrors sslPolicyErrors)
    {
        Android.Util.Log.Verbose("PINNING", $"ValidateCertificate fired: pinning={App.Pinning} sslErrors={sslPolicyErrors} subject={certificate?.Subject}");
        return App.Pinning ? false : true;
    }
}
