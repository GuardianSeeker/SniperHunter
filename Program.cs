using FortniteReplayReader;
using Newtonsoft.Json;
using System.IO;
using System.IO.Pipes;

public class ElectronIPCClient
{
    private readonly string _pipeName;
    private readonly int _timeoutMs;
    private readonly int _maxRetries;

    public ElectronIPCClient(string pipeName = "my-app-pipe", int timeoutMs = 5000, int maxRetries = 3)
    {
        _pipeName = pipeName;
        _timeoutMs = timeoutMs;
        _maxRetries = maxRetries;
    }

    public async Task<bool> SendValueAsync(string value)
    {
        int retryCount = 0;
        while (retryCount < _maxRetries)
        {
            try
            {
                using var pipeClient = new NamedPipeClientStream(".",
                    _pipeName,
                    PipeDirection.Out,
                    PipeOptions.Asynchronous);

                Console.WriteLine("Attempting to connect...");
                await pipeClient.ConnectAsync(_timeoutMs);

                if (!pipeClient.IsConnected)
                {
                    throw new Exception("Failed to connect to pipe.");
                }

                Console.WriteLine("Connected successfully");

                using var writer = new StreamWriter(pipeClient) { AutoFlush = true };
                await writer.WriteAsync(value);
                await writer.FlushAsync();
                pipeClient.WaitForPipeDrain();

                Console.WriteLine("Data sent successfully");
                return true;
            }
            catch (TimeoutException)
            {
                retryCount++;
                Console.WriteLine($"Timeout occurred. Attempt {retryCount} of {_maxRetries}");
                if (retryCount == _maxRetries)
                {
                    throw new TimeoutException($"Failed to connect after {_maxRetries} attempts.");
                }
                await Task.Delay(1000);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error occurred: {ex.Message}");
                retryCount++;
                if (retryCount == _maxRetries)
                {
                    throw new Exception($"Error sending value to Electron: {ex.Message}", ex);
                }
                await Task.Delay(1000);
            }
        }
        return false;
    }
}

class Program
{
    static async Task Main(string[] args)
    {
        try
        {
            if (args.Length == 0)
            {
                throw new Exception("File path not provided.");
            }
            var replayFile = args[0];
            var reader = new ReplayReader();
            var jsonReplay = string.Empty;
            var pipeName = replayFile.Split('\\').Last();
            try
            {
                var replay = reader.ReadReplay(replayFile);
                jsonReplay = JsonConvert.SerializeObject(replay);
            }
            catch (Unreal.Core.Exceptions.InvalidReplayException ex)
            {
                jsonReplay = "Replay in progress.";
            }
            var ipcClient = new ElectronIPCClient(pipeName);
            await ipcClient.SendValueAsync(jsonReplay);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error: {ex.Message}");
        }
    }
}