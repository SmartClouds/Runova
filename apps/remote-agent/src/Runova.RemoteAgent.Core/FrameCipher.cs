using System.Buffers.Binary;
using System.Security.Cryptography;

namespace Runova.RemoteAgent.Core;

/// <summary>
/// Seals relay frames as apps/desktop/src/main/remote/anywhere/relayCipher.ts does: AES-256-GCM
/// with the direction's key, `[counter u64][ciphertext][tag]`, nonce = four zero bytes then the
/// counter, and each frame must carry exactly the next counter.
/// </summary>
public sealed class FrameCipher(byte[] sendKey, byte[] receiveKey) : IDisposable
{
    private const int CounterBytes = 8;
    private const int TagBytes = 16;
    private readonly AesGcm _send = new(sendKey, TagBytes);
    private readonly AesGcm _receive = new(receiveKey, TagBytes);
    private ulong _sent;
    private ulong _expected;

    public byte[] Seal(ReadOnlySpan<byte> frame)
    {
        var counter = _sent++;
        var output = new byte[CounterBytes + frame.Length + TagBytes];
        BinaryPrimitives.WriteUInt64BigEndian(output, counter);
        _send.Encrypt(Nonce(counter), frame, output.AsSpan(CounterBytes, frame.Length), output.AsSpan(CounterBytes + frame.Length));
        return output;
    }

    public byte[] Open(ReadOnlySpan<byte> sealedFrame)
    {
        if (sealedFrame.Length < CounterBytes + TagBytes)
        {
            throw new CryptographicException("A relay frame too short to open.");
        }

        var counter = BinaryPrimitives.ReadUInt64BigEndian(sealedFrame);
        if (counter != _expected)
        {
            throw new CryptographicException("A relay frame out of order, or played again.");
        }

        var length = sealedFrame.Length - CounterBytes - TagBytes;
        var plain = new byte[length];
        _receive.Decrypt(Nonce(counter), sealedFrame.Slice(CounterBytes, length), sealedFrame[^TagBytes..], plain);
        _expected++;
        return plain;
    }

    private static byte[] Nonce(ulong counter)
    {
        var nonce = new byte[12];
        BinaryPrimitives.WriteUInt64BigEndian(nonce.AsSpan(4), counter);
        return nonce;
    }

    public void Dispose()
    {
        _send.Dispose();
        _receive.Dispose();
    }
}
