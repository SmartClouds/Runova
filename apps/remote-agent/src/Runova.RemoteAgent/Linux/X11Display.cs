using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text.Json.Nodes;
using Runova.RemoteAgent.Core;

namespace Runova.RemoteAgent.Linux;

// Xlib queues requests and reports failures through the error handler, not these return values.
#pragma warning disable CA1806

/// <summary>
/// One connection to an X server (E65): reads the root window, through shared memory when the
/// server offers it, and sends mouse and keyboard through XTest. Xlib is not thread safe, so
/// everything takes the same lock. A protocol error (a window gone mid-read) just fails that call;
/// if the server itself goes away Xlib ends the process, and systemd starts the agent again.
/// </summary>
[SupportedOSPlatform("linux")]
internal sealed unsafe class X11Display : IDisposable
{
    private readonly Lock _gate = new();
    private readonly nint _display;
    private readonly nint _root;
    private readonly int _spareKeycode;
    private X11Native.XImage* _shmImage;
    private X11Native.XShmSegmentInfo* _shm;

    private X11Display(nint display)
    {
        _display = display;
        _root = X11Native.XDefaultRootWindow(display);
        _spareKeycode = FindSpareKeycode();
    }

    public static X11Display? Open(string display, string? authFile)
    {
        // libX11 reads XAUTHORITY from the C environment, which Environment.SetEnvironmentVariable does not change.
        if (authFile is null)
        {
            _ = X11Native.unsetenv("XAUTHORITY");
        }
        else
        {
            _ = X11Native.setenv("XAUTHORITY", authFile, 1);
        }

        X11Native.XSetErrorHandler(&IgnoreError);
        var handle = X11Native.XOpenDisplay(display);
        return handle == 0 ? null : new X11Display(handle);
    }

    [UnmanagedCallersOnly]
    private static int IgnoreError(nint display, nint error) => 0;

    public ScreenFrame? Capture()
    {
        lock (_gate)
        {
            if (X11Native.XGetGeometry(_display, _root, out _, out _, out _, out var width, out var height, out _, out _) == 0)
            {
                return null;
            }

            return CaptureShared(width, height) ?? CaptureCopied(width, height);
        }
    }

    private ScreenFrame? CaptureShared(uint width, uint height)
    {
        if (!PrepareShared(width, height) || X11Native.XShmGetImage(_display, _root, _shmImage, 0, 0, X11Native.AllPlanes) == 0)
        {
            return null;
        }

        return Copy(_shmImage);
    }

    private ScreenFrame? CaptureCopied(uint width, uint height)
    {
        var image = X11Native.XGetImage(_display, _root, 0, 0, width, height, X11Native.AllPlanes, X11Native.ZPixmap);
        if (image is null)
        {
            return null;
        }

        var frame = Copy(image);
        X11Native.XDestroyImage(image);
        return frame;
    }

    private static ScreenFrame? Copy(X11Native.XImage* image)
    {
        if (image->BitsPerPixel != 32)
        {
            return null;
        }

        var stride = image->BytesPerLine;
        var pixels = new byte[stride * image->Height];
        Marshal.Copy((nint)image->Data, pixels, 0, pixels.Length);

        // A depth 24 screen leaves the fourth byte unset; the encoder treats the frame as opaque anyway.
        return new ScreenFrame(image->Width, image->Height, stride, pixels);
    }

    private bool PrepareShared(uint width, uint height)
    {
        if (_shmImage is not null)
        {
            if (_shmImage->Width == (int)width && _shmImage->Height == (int)height)
            {
                return true;
            }

            ReleaseShared();
        }

        if (X11Native.XShmQueryExtension(_display) == 0)
        {
            return false;
        }

        var screen = X11Native.XDefaultScreen(_display);
        var info = (X11Native.XShmSegmentInfo*)NativeMemory.AllocZeroed((nuint)sizeof(X11Native.XShmSegmentInfo));
        var image = X11Native.XShmCreateImage(_display, X11Native.XDefaultVisual(_display, screen), (uint)X11Native.XDefaultDepth(_display, screen), X11Native.ZPixmap, null, info, width, height);
        if (image is null)
        {
            NativeMemory.Free(info);
            return false;
        }

        info->ShmId = X11Native.shmget(X11Native.IpcPrivate, (nuint)(image->BytesPerLine * image->Height), X11Native.IpcCreat | 0x180);
        if (info->ShmId < 0)
        {
            X11Native.XDestroyImage(image);
            NativeMemory.Free(info);
            return false;
        }

        info->ShmAddr = X11Native.shmat(info->ShmId, null, 0);
        image->Data = info->ShmAddr;
        var attached = (nint)info->ShmAddr != -1 && X11Native.XShmAttach(_display, info) != 0;
        X11Native.XSync(_display, 0);

        // Marked for removal now, so the segment goes away with us however the process ends.
        X11Native.shmctl(info->ShmId, X11Native.IpcRmid, null);
        if (!attached)
        {
            image->Data = null;
            X11Native.XDestroyImage(image);
            NativeMemory.Free(info);
            return false;
        }

        _shmImage = image;
        _shm = info;
        return true;
    }

    private void ReleaseShared()
    {
        if (_shmImage is null)
        {
            return;
        }

        X11Native.XShmDetach(_display, _shm);
        X11Native.XSync(_display, 0);
        X11Native.shmdt(_shm->ShmAddr);
        _shmImage->Data = null;
        X11Native.XDestroyImage(_shmImage);
        NativeMemory.Free(_shm);
        _shmImage = null;
        _shm = null;
    }

    public void Apply(JsonObject inputEvent)
    {
        lock (_gate)
        {
            if (X11Native.XGetGeometry(_display, _root, out _, out _, out _, out var width, out var height, out _, out _) == 0)
            {
                return;
            }

            foreach (var step in X11Input.Steps(inputEvent, (int)width, (int)height))
            {
                Perform(step);
            }

            X11Native.XSync(_display, 0);
        }
    }

    private void Perform(X11Step step)
    {
        switch (step)
        {
            case X11Step.Move move:
                X11Native.XTestFakeMotionEvent(_display, -1, move.X, move.Y, 0);
                break;
            case X11Step.Button button:
                X11Native.XTestFakeButtonEvent(_display, (uint)button.Number, button.Down ? 1 : 0, 0);
                break;
            case X11Step.Key key:
                var code = X11Native.XKeysymToKeycode(_display, (nuint)key.Keysym);
                if (code != 0)
                {
                    X11Native.XTestFakeKeyEvent(_display, code, key.Down ? 1 : 0, 0);
                }

                break;
            case X11Step.Text text:
                TypeCodePoint(text.CodePoint);
                break;
        }
    }

    /// <summary>Puts the character on an unused key and presses it, so it types whatever the keyboard layout.</summary>
    private void TypeCodePoint(int codePoint)
    {
        var keysym = codePoint < 0x100 ? (nuint)codePoint : (nuint)(0x01000000 | codePoint);
        var pair = stackalloc nuint[2] { keysym, keysym };
        X11Native.XChangeKeyboardMapping(_display, _spareKeycode, 2, pair, 1);
        X11Native.XSync(_display, 0);
        X11Native.XTestFakeKeyEvent(_display, (uint)_spareKeycode, 1, 0);
        X11Native.XTestFakeKeyEvent(_display, (uint)_spareKeycode, 0, 0);
        X11Native.XSync(_display, 0);
    }

    private int FindSpareKeycode()
    {
        X11Native.XDisplayKeycodes(_display, out var low, out var high);
        var syms = X11Native.XGetKeyboardMapping(_display, (byte)low, high - low + 1, out var perCode);
        try
        {
            for (var i = high - low; i >= 0; i--)
            {
                var empty = true;
                for (var j = 0; j < perCode; j++)
                {
                    empty &= syms[(i * perCode) + j] == 0;
                }

                if (empty)
                {
                    return low + i;
                }
            }
        }
        finally
        {
            X11Native.XFree(syms);
        }

        return high;
    }

    /// <summary>Where the pointer is, for tests.</summary>
    public (int X, int Y) Pointer()
    {
        lock (_gate)
        {
            X11Native.XQueryPointer(_display, _root, out _, out _, out var x, out var y, out _, out _, out _);
            return (x, y);
        }
    }

    /// <summary>Whether the left button is down once <paramref name="action"/> has run, for tests.</summary>
    public bool Pressing(Action action)
    {
        ArgumentNullException.ThrowIfNull(action);
        action();
        lock (_gate)
        {
            X11Native.XQueryPointer(_display, _root, out _, out _, out _, out _, out _, out _, out var mask);
            return (mask & X11Native.Button1Mask) != 0;
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            ReleaseShared();
            X11Native.XCloseDisplay(_display);
        }
    }
}
