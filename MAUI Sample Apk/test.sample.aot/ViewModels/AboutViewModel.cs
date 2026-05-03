using System;
using System.ComponentModel;
using System.Windows.Input;
using Microsoft.Maui.Controls;

namespace SampleApp.ViewModels
{
    public class AboutViewModel : BaseViewModel, INotifyPropertyChanged
    {

        public AboutViewModel()
        {
            Title = "About";
            MakeHttpRequest = new Command(MakeHttpRequestImpl);
            TogglePinningCommand = new Command(TogglePinning);
            ClearLogs = new Command(DoClearLogs);
            TogglePinning(null);
        }


        private void LogToBoth(string msg)
        {
            LogOutput += msg;
            App.Log?.WriteLine(msg.TrimEnd('\n'));
        }

        private void TogglePinning(object sender)
        {
            App.Pinning = !App.Pinning;
            LogToBoth(DateTime.Now.ToString() + $"> Pinning: {(App.Pinning ? "ON" : "OFF")}\n");
        }

        private async void MakeHttpRequestImpl(object obj)
        {
            RequestStatus = "Starting Request";
            LogToBoth(DateTime.Now.ToString() + "> Making Request\n");
            try
            {
                var r = await App.Http.GetAsync("https://ymuu.me/?MAUI=Great-Job-Buddy&k=" + DateTime.Now.Ticks.ToString());
                RequestStatus = "Return Code: " + r.StatusCode.ToString();
                LogToBoth(DateTime.Now.ToString() + "> Got Response: " + RequestStatus + "\n");
            }
            catch (Exception e)
            {
                var sb = new System.Text.StringBuilder();
                for (var x = e; x != null; x = x.InnerException)
                {
                    sb.AppendLine($"[{x.GetType().FullName}] {x.Message}");
                    sb.AppendLine(x.StackTrace);
                    sb.AppendLine("---");
                }
                RequestStatus = "Exception: " + e.Message;
                LogToBoth(DateTime.Now + "> Got Exception:\n" + sb.ToString());
            }
        }

        private void DoClearLogs(object obj)
        {
            LogOutput = "";
        }


        public ICommand MakeHttpRequest { get; }
        public ICommand TogglePinningCommand { get; }
        public ICommand ClearLogs { get; }

        private string _reqStat;
        public string RequestStatus
        {
            get { return _reqStat; }
            set
            {
                _reqStat = value;
                OnPropertyChanged(nameof(RequestStatus));
            }
        }


        private string _logs;
        public string LogOutput
        {
            get
            { return _logs; }

            set
            {
                _logs = value;
                OnPropertyChanged(nameof(LogOutput));

            }
        }
    }
}
