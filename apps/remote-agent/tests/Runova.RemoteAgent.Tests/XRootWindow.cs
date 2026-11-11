using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Runova.RemoteAgent.Linux;

namespace Runova.RemoteAgent.Tests;

/// <summary>
/// Paints an X server's root window one solid color, the way xsetroot -solid does. The capture
/// test does this itself so the machine needs nothing but Xvfb: the self-hosted Linux runners have
/// no x11-xserver-utils, and no passwordless sudo to install it with.
/// </summary>
[SupportedOSPlatform("linux")]
internal static partial class XRootWindow
{
    private const string X11 = "libX11.so.6";

    /// <summary>Sets the root background to <paramref name="pixel"/> (0xRRGGBB on a TrueColor screen).</summary>
    public static void Paint(string display, uint pixel)
    {
        var handle = X11Native.XOpenDisplay(display);
        if (handle == 0)
        {
            throw new InvalidOperationException($"Could not open the X display {display}.");
        }

        try
        {
            var root = X11Native.XDefaultRootWindow(handle);
            _ = XSetWindowBackground(handle, root, pixel);
            _ = XClearWindow(handle, root);
            // The background outlives this connection, as with xsetroot, because Xvfb runs with
            // -noreset and the root window is not a resource of this client.
            _ = X11Native.XSync(handle, 0);
        }
        finally
        {
            _ = X11Native.XCloseDisplay(handle);
        }
    }

    [LibraryImport(X11)]
    private static partial int XSetWindowBackground(nint display, nint window, nuint pixel);

    [LibraryImport(X11)]
    private static partial int XClearWindow(nint display, nint window);
}
