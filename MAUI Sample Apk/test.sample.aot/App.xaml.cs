using System.Net.Http;
using Microsoft.Maui.Controls;
using SampleApp.Services;
using SampleApp.Views;

namespace SampleApp;

public partial class App : Application
{
    public static ILogger Log;
    public static HttpClient Http;
    public static bool Pinning;

    public App(ILogger logger, HttpClient http)
    {
        InitializeComponent();
        Log = logger;
        Http = http;

        DependencyService.Register<MockDataStore>();
        MainPage = new MainPage();
    }
}
