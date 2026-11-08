using System.Runtime.InteropServices;
using System.Runtime.InteropServices.Marshalling;
using System.Runtime.Versioning;
using System.Text.Json.Nodes;
using Runova.RemoteAgent.Core;

namespace Runova.RemoteAgent.Mac;

[SupportedOSPlatform("macos")]
internal static unsafe partial class MacNative
{
    private const string CoreGraphics = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
    private const string CoreFoundation = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

    public const int HidEventTap = 0;
    public const int ScrollUnitLine = 1;

    [StructLayout(LayoutKind.Sequential)]
    public struct CGPoint
    {
        public double X;
        public double Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct CGRect
    {
        public CGPoint Origin;
        public double Width;
        public double Height;
    }

    [LibraryImport(CoreGraphics)]
    public static partial uint CGMainDisplayID();

    [LibraryImport(CoreGraphics)]
    public static partial CGRect CGDisplayBounds(uint display);

    [LibraryImport(CoreGraphics)]
    public static partial nint CGDisplayCreateImage(uint display);

    [LibraryImport(CoreGraphics)]
    public static partial nuint CGImageGetWidth(nint image);

    [LibraryImport(CoreGraphics)]
    public static partial nuint CGImageGetHeight(nint image);

    [LibraryImport(CoreGraphics)]
    public static partial nuint CGImageGetBytesPerRow(nint image);

    [LibraryImport(CoreGraphics)]
    public static partial nuint CGImageGetBitsPerPixel(nint image);

    [LibraryImport(CoreGraphics)]
    public static partial nint CGImageGetDataProvider(nint image);

    [LibraryImport(CoreGraphics)]
    public static partial nint CGDataProviderCopyData(nint provider);

    [LibraryImport(CoreGraphics)]
    public static partial nint CGEventCreateMouseEvent(nint source, int type, CGPoint position, int button);

    [LibraryImport(CoreGraphics)]
    public static partial nint CGEventCreateKeyboardEvent(nint source, ushort key, [MarshalAs(UnmanagedType.U1)] bool down);

    [LibraryImport(CoreGraphics)]
    public static partial nint CGEventCreateScrollWheelEvent2(nint source, int units, uint wheelCount, int vertical, int horizontal, int unused);

    [LibraryImport(CoreGraphics)]
    public static partial void CGEventKeyboardSetUnicodeString(nint keyEvent, nuint length, char* text);

    [LibraryImport(CoreGraphics)]
    public static partial void CGEventPost(int tap, nint cgEvent);

    [LibraryImport(CoreFoundation)]
    public static partial void CFRelease(nint value);

    [LibraryImport(CoreFoundation)]
    public static partial nint CFDataGetLength(nint data);

    [LibraryImport(CoreFoundation)]
    public static partial byte* CFDataGetBytePtr(nint data);
}

/// <summary>
/// The screen and input on macOS (E65), through Core Graphics. The agent runs at the login window,
/// where it can see the screen and post events; a capture macOS refuses just gives no frame.
/// </summary>
[SupportedOSPlatform("macos")]
internal sealed unsafe class MacAgentPlatform : IAgentPlatform, IScreenSource, IInputSink, IDisposable
{
    private readonly JpegTileEncoder _encoder = new();
    private readonly MacButtons _held = new();
    private readonly Lock _inputGate = new();

    public IScreenSource Screen => this;

    public ITileEncoder Encoder => _encoder;

    public IInputSink Input => this;

    public ScreenFrame? Capture()
    {
        nint image;
        try
        {
            image = MacNative.CGDisplayCreateImage(MacNative.CGMainDisplayID());
        }
        catch (EntryPointNotFoundException)
        {
            return null;
        }

        if (image == 0)
        {
            return null;
        }

        try
        {
            if (MacNative.CGImageGetBitsPerPixel(image) != 32)
            {
                return null;
            }

            var data = MacNative.CGDataProviderCopyData(MacNative.CGImageGetDataProvider(image));
            if (data == 0)
            {
                return null;
            }

            try
            {
                var stride = (int)MacNative.CGImageGetBytesPerRow(image);
                var height = (int)MacNative.CGImageGetHeight(image);
                var pixels = new byte[stride * height];
                Marshal.Copy((nint)MacNative.CFDataGetBytePtr(data), pixels, 0, Math.Min(pixels.Length, (int)MacNative.CFDataGetLength(data)));
                return new ScreenFrame((int)MacNative.CGImageGetWidth(image), height, stride, pixels);
            }
            finally
            {
                MacNative.CFRelease(data);
            }
        }
        finally
        {
            MacNative.CFRelease(image);
        }
    }

    public void Apply(JsonObject inputEvent)
    {
        lock (_inputGate)
        {
            var bounds = MacNative.CGDisplayBounds(MacNative.CGMainDisplayID());
            foreach (var step in MacInput.Steps(inputEvent, bounds.Width, bounds.Height, _held))
            {
                Perform(step, bounds.Origin);
            }
        }
    }

    private static void Perform(MacStep step, MacNative.CGPoint origin)
    {
        switch (step)
        {
            case MacStep.Mouse mouse:
                Post(MacNative.CGEventCreateMouseEvent(0, mouse.Type, new MacNative.CGPoint { X = origin.X + mouse.X, Y = origin.Y + mouse.Y }, mouse.Button));
                break;
            case MacStep.Key key:
                Post(MacNative.CGEventCreateKeyboardEvent(0, key.VirtualKey, key.Down));
                break;
            case MacStep.Scroll scroll:
                Post(MacNative.CGEventCreateScrollWheelEvent2(0, MacNative.ScrollUnitLine, 2, scroll.Vertical, scroll.Horizontal, 0));
                break;
            case MacStep.Text text:
                PostText(text.Value);
                break;
        }
    }

    private static void PostText(string text)
    {
        foreach (var down in new[] { true, false })
        {
            var keyEvent = MacNative.CGEventCreateKeyboardEvent(0, 0, down);
            if (keyEvent == 0)
            {
                return;
            }

            fixed (char* characters = text)
            {
                MacNative.CGEventKeyboardSetUnicodeString(keyEvent, (nuint)text.Length, characters);
            }

            Post(keyEvent);
        }
    }

    private static void Post(nint cgEvent)
    {
        if (cgEvent != 0)
        {
            MacNative.CGEventPost(MacNative.HidEventTap, cgEvent);
            MacNative.CFRelease(cgEvent);
        }
    }

    public void Dispose() => _encoder.Dispose();
}
