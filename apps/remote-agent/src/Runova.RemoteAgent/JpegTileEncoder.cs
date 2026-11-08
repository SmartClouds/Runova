using System.Runtime.InteropServices;
using Runova.RemoteAgent.Core;
using SkiaSharp;

namespace Runova.RemoteAgent;

/// <summary>Part of the screen as a JPEG, on every OS the agent runs on.</summary>
internal sealed class JpegTileEncoder : ITileEncoder, IDisposable
{
    private const int Quality = 70;

    public byte[] Encode(ScreenFrame frame, TileRect rect)
    {
        ArgumentNullException.ThrowIfNull(frame);
        var pinned = GCHandle.Alloc(frame.Pixels, GCHandleType.Pinned);
        try
        {
            var start = pinned.AddrOfPinnedObject() + (rect.Y * frame.Stride) + (rect.X * 4);
            var info = new SKImageInfo(rect.W, rect.H, SKColorType.Bgra8888, SKAlphaType.Opaque);
            using var pixmap = new SKPixmap(info, start, frame.Stride);
            using var jpeg = pixmap.Encode(SKEncodedImageFormat.Jpeg, Quality) ?? throw new InvalidOperationException("The tile could not be encoded.");
            return jpeg.ToArray();
        }
        finally
        {
            pinned.Free();
        }
    }

    public void Dispose()
    {
    }
}
