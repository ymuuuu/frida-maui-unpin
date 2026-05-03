using SampleApp;

public class Logger : ILogger
{
    public void WriteLine(string msg)
    {
        Android.Util.Log.Verbose("PINNING", msg);
    }
}
