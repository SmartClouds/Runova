using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text.Json.Nodes;
using Runova.RemoteAgent.Core;

namespace Runova.RemoteAgent.Windows;

/// <summary>
/// One thread that does all of the agent's screen and input work on Windows (E64). Before each job
/// it moves itself to the input desktop: the user's desktop, or Winlogon's while the computer is
/// locked or on the sign-in screen, or the secure desktop of a UAC prompt. A thread with no windows
/// can switch desktops, and the session helper runs as SYSTEM, which may open all of them.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class DesktopThread : IDisposable
{
    private static readonly nint _perMonitorAwareV2 = -4;
    private readonly BlockingCollection<Action> _jobs = [];
    private readonly Thread _thread;

    public DesktopThread()
    {
        _thread = new Thread(Run) { IsBackground = true, Name = "Runova input desktop" };
        _thread.Start();
    }

    public T Invoke<T>(Func<T> job)
    {
        var done = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        _jobs.Add(() =>
        {
            try
            {
                done.SetResult(job());
            }
            catch (Exception e)
            {
                done.SetException(e);
            }
        });
        return done.Task.GetAwaiter().GetResult();
    }

    private void Run()
    {
        NativeMethods.SetThreadDpiAwarenessContext(_perMonitorAwareV2);
        foreach (var job in _jobs.GetConsumingEnumerable())
        {
            var desktop = NativeMethods.OpenInputDesktop(0, false, NativeMethods.GenericAll);
            if (desktop != 0)
            {
                NativeMethods.SetThreadDesktop(desktop);
            }

            try
            {
                job();
            }
            finally
            {
                if (desktop != 0)
                {
                    NativeMethods.CloseDesktop(desktop);
                }
            }
        }
    }

    public void Dispose() => _jobs.CompleteAdding();
}

/// <summary>The primary screen of the input desktop, through GDI, which works on the sign-in screen too.</summary>
[SupportedOSPlatform("windows")]
internal sealed class GdiScreenSource(DesktopThread desktop) : IScreenSource
{
    public ScreenFrame? Capture() => desktop.Invoke(CaptureOnDesktop);

    private static ScreenFrame? CaptureOnDesktop()
    {
        var width = NativeMethods.GetSystemMetrics(NativeMethods.SmCxScreen);
        var height = NativeMethods.GetSystemMetrics(NativeMethods.SmCyScreen);
        if (width <= 0 || height <= 0)
        {
            return null;
        }

        var screenDc = NativeMethods.GetDC(0);
        var memoryDc = NativeMethods.CreateCompatibleDC(screenDc);
        var info = new NativeMethods.BitmapInfo
        {
            Size = Marshal.SizeOf<NativeMethods.BitmapInfo>(),
            Width = width,
            Height = -height,
            Planes = 1,
            BitCount = 32,
        };
        var bitmap = NativeMethods.CreateDIBSection(screenDc, ref info, 0, out var bits, 0, 0);
        try
        {
            if (bitmap == 0)
            {
                return null;
            }

            var previous = NativeMethods.SelectObject(memoryDc, bitmap);
            var copied = NativeMethods.BitBlt(memoryDc, 0, 0, width, height, screenDc, 0, 0, NativeMethods.SrcCopy | NativeMethods.CaptureBlt);
            NativeMethods.SelectObject(memoryDc, previous);
            if (!copied)
            {
                return null;
            }

            var pixels = new byte[width * height * 4];
            Marshal.Copy(bits, pixels, 0, pixels.Length);
            return new ScreenFrame(width, height, width * 4, pixels);
        }
        finally
        {
            if (bitmap != 0)
            {
                NativeMethods.DeleteObject(bitmap);
            }

            NativeMethods.DeleteDC(memoryDc);
            _ = NativeMethods.ReleaseDC(0, screenDc);
        }
    }
}

/// <summary>Mouse and keyboard on the input desktop through SendInput.</summary>
[SupportedOSPlatform("windows")]
internal sealed class SendInputSink(DesktopThread desktop) : IInputSink
{
    private static readonly bool[] _downThenUp = [false, true];

    public void Apply(JsonObject inputEvent) => desktop.Invoke(() =>
    {
        var width = NativeMethods.GetSystemMetrics(NativeMethods.SmCxScreen);
        var height = NativeMethods.GetSystemMetrics(NativeMethods.SmCyScreen);
        foreach (var step in Win32Input.Steps(inputEvent, width, height))
        {
            switch (step)
            {
                case InputStep.Move move:
                    NativeMethods.SetCursorPos(move.X, move.Y);
                    break;
                case InputStep.Mouse mouse:
                    Send(new NativeMethods.Input
                    {
                        Type = NativeMethods.InputMouse,
                        Data = new NativeMethods.InputUnion { Mouse = new NativeMethods.MouseInput { Flags = mouse.Flags, MouseData = mouse.Data } },
                    });
                    break;
                case InputStep.Key key:
                    Send(new NativeMethods.Input
                    {
                        Type = NativeMethods.InputKeyboard,
                        Data = new NativeMethods.InputUnion
                        {
                            Keyboard = new NativeMethods.KeyboardInput
                            {
                                VirtualKey = key.VirtualKey,
                                Flags = (key.Down ? 0 : NativeMethods.KeyEventFKeyUp) | (key.Extended ? NativeMethods.KeyEventFExtendedKey : 0),
                            },
                        },
                    });
                    break;
                case InputStep.Unicode unicode:
                    foreach (var up in _downThenUp)
                    {
                        Send(new NativeMethods.Input
                        {
                            Type = NativeMethods.InputKeyboard,
                            Data = new NativeMethods.InputUnion
                            {
                                Keyboard = new NativeMethods.KeyboardInput
                                {
                                    Scan = unicode.Character,
                                    Flags = NativeMethods.KeyEventFUnicode | (up ? NativeMethods.KeyEventFKeyUp : 0),
                                },
                            },
                        });
                    }

                    break;
            }
        }

        return true;
    });

    private static void Send(NativeMethods.Input input) => NativeMethods.SendInput(1, [input], Marshal.SizeOf<NativeMethods.Input>());
}
