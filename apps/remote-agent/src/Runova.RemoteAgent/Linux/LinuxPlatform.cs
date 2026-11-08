using System.Diagnostics;
using System.Runtime.Versioning;
using System.Text.Json.Nodes;
using Runova.RemoteAgent.Core;

namespace Runova.RemoteAgent.Linux;

/// <summary>
/// The screen and input on Linux (E65): whichever X server is on the physical screen, the greeter's
/// or a signed-in desktop's. It looks again when that may have changed, so the agent follows the
/// computer between them. With no X server (a Wayland greeter) there is no screen to offer.
/// </summary>
[SupportedOSPlatform("linux")]
internal sealed class LinuxAgentPlatform : IAgentPlatform, IScreenSource, IInputSink, IDisposable
{
    private static readonly TimeSpan _lookAgainAfter = TimeSpan.FromSeconds(2);
    private readonly Lock _gate = new();
    private readonly JpegTileEncoder _encoder = new();
    private readonly Stopwatch _sinceLook = new();
    private XServer? _server;
    private X11Display? _display;

    public IScreenSource Screen => this;

    public ITileEncoder Encoder => _encoder;

    public IInputSink Input => this;

    public ScreenFrame? Capture() => Current()?.Capture();

    public void Apply(JsonObject inputEvent) => Current()?.Apply(inputEvent);

    private X11Display? Current()
    {
        lock (_gate)
        {
            if (_sinceLook.IsRunning && _sinceLook.Elapsed < _lookAgainAfter)
            {
                return _display;
            }

            _sinceLook.Restart();
            var server = XServerDiscovery.Current();
            if (server == _server && _display is not null)
            {
                return _display;
            }

            _display?.Dispose();
            _display = null;
            _server = server;
            if (server is not null)
            {
                foreach (var candidate in XServerDiscovery.Candidates(server))
                {
                    _display = X11Display.Open(candidate, server.AuthFile);
                    if (_display is not null)
                    {
                        break;
                    }
                }
            }

            return _display;
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _display?.Dispose();
            _display = null;
        }

        _encoder.Dispose();
    }
}
