using System.Runtime.InteropServices;
using System.Runtime.InteropServices.Marshalling;
using System.Runtime.Versioning;

namespace Runova.RemoteAgent.Linux;

/// <summary>The parts of libX11, MIT-SHM and XTest the agent needs, plus setenv and System V shared memory.</summary>
[SupportedOSPlatform("linux")]
internal static unsafe partial class X11Native
{
    private const string X11 = "libX11.so.6";
    private const string Xext = "libXext.so.6";
    private const string Xtst = "libXtst.so.6";
    private const string LibC = "libc";

    public const int ZPixmap = 2;
    public const ulong AllPlanes = ulong.MaxValue;
    public const int IpcPrivate = 0;
    public const int IpcCreat = 0x200;
    public const int IpcRmid = 0;
    public const uint Button1Mask = 1 << 8;

    /// <summary>The head of Xlib's XImage: everything up to its function pointers.</summary>
    [StructLayout(LayoutKind.Sequential)]
    public struct XImage
    {
        public int Width;
        public int Height;
        public int XOffset;
        public int Format;
        public byte* Data;
        public int ByteOrder;
        public int BitmapUnit;
        public int BitmapBitOrder;
        public int BitmapPad;
        public int Depth;
        public int BytesPerLine;
        public int BitsPerPixel;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct XShmSegmentInfo
    {
        public nuint ShmSeg;
        public int ShmId;
        public byte* ShmAddr;
        public int ReadOnly;
    }

    [LibraryImport(X11, StringMarshalling = StringMarshalling.Utf8)]
    public static partial nint XOpenDisplay(string? name);

    [LibraryImport(X11)]
    public static partial int XCloseDisplay(nint display);

    [LibraryImport(X11)]
    public static partial nint XSetErrorHandler(delegate* unmanaged<nint, nint, int> handler);

    [LibraryImport(X11)]
    public static partial nint XDefaultRootWindow(nint display);

    [LibraryImport(X11)]
    public static partial int XDefaultScreen(nint display);

    [LibraryImport(X11)]
    public static partial nint XDefaultVisual(nint display, int screen);

    [LibraryImport(X11)]
    public static partial int XDefaultDepth(nint display, int screen);

    [LibraryImport(X11)]
    public static partial int XGetGeometry(nint display, nint drawable, out nint root, out int x, out int y, out uint width, out uint height, out uint border, out uint depth);

    [LibraryImport(X11)]
    public static partial XImage* XGetImage(nint display, nint drawable, int x, int y, uint width, uint height, ulong planes, int format);

    [LibraryImport(X11)]
    public static partial int XDestroyImage(XImage* image);

    [LibraryImport(X11)]
    public static partial int XSync(nint display, int discard);

    [LibraryImport(X11)]
    public static partial int XFlush(nint display);

    [LibraryImport(X11)]
    public static partial byte XKeysymToKeycode(nint display, nuint keysym);

    [LibraryImport(X11)]
    public static partial int XDisplayKeycodes(nint display, out int low, out int high);

    [LibraryImport(X11)]
    public static partial nuint* XGetKeyboardMapping(nint display, byte first, int count, out int perCode);

    [LibraryImport(X11)]
    public static partial int XChangeKeyboardMapping(nint display, int first, int perCode, nuint* keysyms, int count);

    [LibraryImport(X11)]
    public static partial int XFree(void* data);

    [LibraryImport(X11)]
    public static partial int XQueryPointer(nint display, nint window, out nint root, out nint child, out int rootX, out int rootY, out int winX, out int winY, out uint mask);

    [LibraryImport(Xext)]
    public static partial int XShmQueryExtension(nint display);

    [LibraryImport(Xext)]
    public static partial XImage* XShmCreateImage(nint display, nint visual, uint depth, int format, byte* data, XShmSegmentInfo* info, uint width, uint height);

    [LibraryImport(Xext)]
    public static partial int XShmAttach(nint display, XShmSegmentInfo* info);

    [LibraryImport(Xext)]
    public static partial int XShmDetach(nint display, XShmSegmentInfo* info);

    [LibraryImport(Xext)]
    public static partial int XShmGetImage(nint display, nint drawable, XImage* image, int x, int y, ulong planes);

    [LibraryImport(Xtst)]
    public static partial int XTestFakeMotionEvent(nint display, int screen, int x, int y, ulong delay);

    [LibraryImport(Xtst)]
    public static partial int XTestFakeButtonEvent(nint display, uint button, int isPress, ulong delay);

    [LibraryImport(Xtst)]
    public static partial int XTestFakeKeyEvent(nint display, uint keycode, int isPress, ulong delay);

    [LibraryImport(LibC, StringMarshalling = StringMarshalling.Utf8)]
    public static partial int setenv(string name, string value, int overwrite);

    [LibraryImport(LibC, StringMarshalling = StringMarshalling.Utf8)]
    public static partial int unsetenv(string name);

    [LibraryImport(LibC)]
    public static partial int shmget(int key, nuint size, int flags);

    [LibraryImport(LibC)]
    public static partial byte* shmat(int id, void* address, int flags);

    [LibraryImport(LibC)]
    public static partial int shmdt(void* address);

    [LibraryImport(LibC)]
    public static partial int shmctl(int id, int command, void* buffer);
}
